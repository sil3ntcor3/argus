import { createCipheriv, createHash, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import type { DataSource } from 'typeorm';
import { decryptWithDEK, encryptWithDEK, unwrapDEK, wrapDEK } from '@/common/utils/workspace-encryption.util';
import { RedisLockService } from '../redis/distributed-lock.service';
import { ServicesModule } from '../services.module';
import type { WorkspaceEncryptionService } from './workspace-encryption.service';

const OLD_KEY = 'upgrade-old-key-0123456789abcdef0123456789';
const NEW_KEY = 'upgrade-new-key-0123456789abcdef0123456789';
const DEK = Buffer.from('0123456789abcdef0123456789abcdef');
const kek = (raw: string) => createHash('sha256').update(raw).digest();
const legacy = (key: Buffer, value: string | Buffer): string => {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const plain = typeof value === 'string' ? Buffer.from(value) : value;
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${iv.toString('hex')}:${data.toString('hex')}`;
};

interface Counts {
  rewrapped: number;
  reencrypted: number;
  unreadable: number;
}
interface Upgrade {
  upgrade(): Promise<Counts | undefined>;
  onApplicationBootstrap(): Promise<void>;
}
interface Row {
  id: string;
  workspaceId?: string | null;
  dek?: string;
  value?: unknown;
}
type UpgradeConstructor = new (
  dataSource: DataSource,
  encryption: WorkspaceEncryptionService,
) => Upgrade;

// Exercise the existing bootstrap registration boundary without importing a
// nonexistent service: the initial regression fails on missing registration.
const upgradeConstructor = (): UpgradeConstructor => {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ServicesModule) as unknown[];
  const provider = providers.find(
    (candidate) => typeof candidate === 'function' && candidate.name === 'EncryptionUpgradeService',
  );
  expect(provider).toBeDefined();
  return provider as UpgradeConstructor;
};

describe('EncryptionUpgradeService', () => {
  const originalKeys = process.env.ENCRYPTION_KEYS;
  let store: Record<string, Row[]>;
  let beforeUpdate: ((table: string, row: Row) => void) | undefined;
  let service: Upgrade;
  let query: jest.Mock;

  const createService = () => {
    query = jest.fn((sql: string, parameters: unknown[] = []) => {
      const table = /(?:FROM|UPDATE) "?(\w+)"?/.exec(sql)?.[1];
      if (!table) throw new Error(`Unexpected query: ${sql}`);
      const rows = store[table] ?? [];
      if (sql.startsWith('SELECT')) return structuredClone(rows);
      const column = /SET "?(\w+)"? = \$1/.exec(sql)?.[1];
      expect(sql).toMatch(new RegExp(`WHERE id = \\$2 AND "?${column}"? = \\$3`));
      const [next, id, previous] = parameters;
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return [[], 0];
      beforeUpdate?.(table, row);
      const field = table === 'workspaces' ? 'dek' : 'value';
      const serialize = (value: unknown) => sql.includes('::jsonb') ? JSON.stringify(value) : value;
      if (serialize(row[field]) !== previous) return [[], 0];
      if (field === 'dek') row.dek = next as string;
      else row.value = sql.includes('::jsonb') ? JSON.parse(next as string) as unknown : next;
      return [[], 1];
    });
    const workspaceEncryption = {
      getDEK: jest.fn((id: string) => {
        const workspace = store.workspaces.find((row) => row.id === id);
        return workspace?.dek ? unwrapDEK(workspace.dek) : null;
      }),
    };
    const Constructor = upgradeConstructor();
    service = new Constructor(
      { query } as unknown as DataSource,
      workspaceEncryption as unknown as WorkspaceEncryptionService,
    );
    return service;
  };

  beforeEach(() => {
    process.env.ENCRYPTION_KEYS = `${OLD_KEY},${NEW_KEY}`;
    store = { workspaces: [{ id: 'good', dek: `0:${legacy(kek(OLD_KEY), DEK)}` }] };
    beforeUpdate = undefined;
    jest.spyOn(RedisLockService, 'current', 'get').mockReturnValue({
      withLock: async (_key: string, _ttl: number, action: () => Promise<unknown>) => action(),
    } as RedisLockService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalKeys === undefined) delete process.env.ENCRYPTION_KEYS;
    else process.env.ENCRYPTION_KEYS = originalKeys;
    jest.restoreAllMocks();
  });

  it('registers the boot upgrade in ServicesModule', () => {
    expect(upgradeConstructor()).toBeDefined();
  });

  it('upgrades each credential store including map and legacy array workflow jobs', async () => {
    store.agent_llm_configs = [{ id: 'llm', workspaceId: 'good', value: `0:${legacy(kek(OLD_KEY), 'llm-key')}` }];
    store.agent_configs = [{ id: 'agent', workspaceId: 'good', value: [{ provider: 'tavily', apiKey: legacy(DEK, 'search-key') }] }];
    store.integrations = [{ id: 'integration', workspaceId: 'good', value: { apiToken: legacy(DEK, 'integration-key'), host: 'example.com' } }];
    store.tool_config_profiles = [{ id: 'profile', workspaceId: 'good', value: { password: `0:${legacy(kek(OLD_KEY), 'profile-key')}` } }];
    const unchanged = legacy(DEK, 'not-a-config-field');
    store.workflows = [
      { id: 'map', workspaceId: 'good', value: { name: unchanged, jobs: { scan: { run: 'tool', config: { apiToken: legacy(DEK, 'map-key'), retries: 2 } } } } },
      { id: 'array', workspaceId: 'good', value: { jobs: [{ run: 'tool', config: { apiToken: legacy(DEK, 'array-key') } }] } },
    ];

    const counts = await createService().upgrade();

    expect(counts).toMatchObject({ rewrapped: 1, reencrypted: 6, unreadable: 0 });
    expect(store.workspaces[0].dek).toMatch(/^v2:/);
    process.env.ENCRYPTION_KEYS = NEW_KEY;
    expect(unwrapDEK(store.workspaces[0].dek!).equals(DEK)).toBe(true);
    const llm = store.agent_llm_configs[0].value as string;
    const providers = store.agent_configs[0].value as { apiKey: string }[];
    const integration = store.integrations[0].value as Record<string, string>;
    const profile = store.tool_config_profiles[0].value as Record<string, string>;
    const mapped = store.workflows[0].value as { name: string; jobs: { scan: { config: { apiToken: string; retries: number } } } };
    const array = store.workflows[1].value as { jobs: { config: { apiToken: string } }[] };
    expect([llm, providers[0].apiKey, integration.apiToken, profile.password, mapped.jobs.scan.config.apiToken, array.jobs[0].config.apiToken].map((value) => decryptWithDEK(value, DEK))).toEqual([
      'llm-key', 'search-key', 'integration-key', 'profile-key', 'map-key', 'array-key',
    ]);
    expect(integration.host).toBe('example.com');
    expect(mapped.name).toBe(unchanged);
    expect(mapped.jobs.scan.config.retries).toBe(2);
    expect(await service.upgrade()).toMatchObject({ rewrapped: 0, reencrypted: 0, unreadable: 0 });
  });

  it('preserves unreadable DEKs and ciphertexts while continuing later rows and stores', async () => {
    const unavailable = `v2:0000000000000000:${'00'.repeat(12)}:${'00'.repeat(16)}:00`;
    const badDek = unavailable;
    const badSecret = unavailable;
    store.workspaces.unshift({ id: 'bad', dek: badDek });
    store.integrations = [
      { id: 'bad-workspace', workspaceId: 'bad', value: { apiToken: badSecret } },
      { id: 'bad-secret', workspaceId: 'good', value: { apiToken: badSecret, label: 'plain' } },
      { id: 'readable', workspaceId: 'good', value: { apiToken: legacy(DEK, 'readable') } },
    ];
    store.workflows = [{ id: 'later-store', workspaceId: 'good', value: { jobs: { scan: { config: { token: legacy(DEK, 'later') } } } } }];

    const counts = await createService().upgrade();

    expect(counts).toMatchObject({ rewrapped: 1, reencrypted: 2, unreadable: 3 });
    expect(store.workspaces[0].dek).toBe(badDek);
    expect(store.integrations[0].value).toEqual({ apiToken: badSecret });
    expect(store.integrations[1].value).toEqual({ apiToken: badSecret, label: 'plain' });
    expect((store.integrations[2].value as { apiToken: string }).apiToken).toMatch(/^v2:dek:/);
  });

  it('does not overwrite a DEK or config changed after its SELECT', async () => {
    store.tool_config_profiles = [{ id: 'profile', workspaceId: 'good', value: { token: legacy(DEK, 'old-token') } }];
    const newerDek = `0:${legacy(kek(OLD_KEY), DEK)}`;
    beforeUpdate = (table, row) => {
      if (table === 'workspaces') row.dek = newerDek;
      else row.value = { token: 'concurrent-edit' };
    };

    expect(await createService().upgrade()).toMatchObject({ rewrapped: 0, reencrypted: 0 });
    expect(store.workspaces[0].dek).toBe(newerDek);
    expect(store.tool_config_profiles[0].value).toEqual({ token: 'concurrent-edit' });
  });

  it('reports corrupt current ciphertext without rewriting it', async () => {
    const tamper = (value: string) => {
      const parts = value.split(':');
      parts[3] = (parts[3][0] === '0' ? '1' : '0') + parts[3].slice(1);
      return parts.join(':');
    };
    const badDek = tamper(wrapDEK(DEK));
    const badSecret = tamper(encryptWithDEK('token', DEK));
    store.workspaces.push({ id: 'bad', dek: badDek });
    store.integrations = [{ id: 'bad-secret', workspaceId: 'good', value: { token: badSecret } }];

    expect(await createService().upgrade()).toMatchObject({ rewrapped: 1, reencrypted: 0, unreadable: 2 });
    expect(store.workspaces[1].dek).toBe(badDek);
    expect(store.integrations[0].value).toEqual({ token: badSecret });
  });

  it('leaves plaintext and malformed workflow structures unchanged', async () => {
    const values: unknown[] = [null, 'plain', [], { jobs: null }, { jobs: { scan: null, plain: 'value', array: [] } }, { jobs: [{ config: 'plain' }, null] }];
    store.workflows = values.map((value, index) => ({ id: String(index), workspaceId: 'good', value }));
    store.integrations = [{ id: 'plain', workspaceId: 'good', value: { password: 'plain-secret', nested: { password: 'untouched' } } }];

    expect(await createService().upgrade()).toMatchObject({ reencrypted: 0, unreadable: 0 });
    expect(store.workflows.map((row) => row.value)).toEqual(values);
    expect(store.integrations[0].value).toEqual({ password: 'plain-secret', nested: { password: 'untouched' } });
  });

  it('runs the upgrade during bootstrap and logs failures without rejecting boot', async () => {
    createService();
    await service.onApplicationBootstrap();
    expect(store.workspaces[0].dek).toMatch(/^v2:/);
    query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalled();
    expect(Logger.prototype.log).not.toHaveBeenCalledWith(expect.stringMatching(/no longer needed|every stored secret/i));
  });
});
