import { createCipheriv, createHash, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import { dataSourceOptions } from '@/database/database-config';
import { decryptWithDEK, unwrapDEK } from '@/common/utils/workspace-encryption.util';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { RedisLockService } from '@/services/redis/distributed-lock.service';
import { EncryptionUpgradeService } from '@/services/workspace-encryption/encryption-upgrade.service';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';

const OLD_KEY = 'e2e-upgrade-old-0123456789abcdef0123456789';
const NEW_KEY = 'e2e-upgrade-new-0123456789abcdef0123456789';
const DEK = Buffer.from('0123456789abcdef0123456789abcdef');
const legacy = (key: Buffer, value: string | Buffer): string => {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const data = Buffer.concat([
    cipher.update(typeof value === 'string' ? Buffer.from(value) : value),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${data.toString('hex')}`;
};

describe('Encryption upgrade SQL integration', () => {
  const originalKeys = process.env.ENCRYPTION_KEYS;
  const unavailable = `v2:0000000000000000:${'00'.repeat(12)}:${'00'.repeat(16)}:00`;
  let dataSource: DataSource;
  let runner: QueryRunner;
  let upgrade: EncryptionUpgradeService;
  let workspaceId: string;
  let badWorkspaceId: string;
  let workflowId: string;
  let integrationId: string;
  let conflictId: string | undefined;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEYS = `${OLD_KEY},${NEW_KEY}`;
    dataSource = new DataSource({ ...dataSourceOptions, migrationsRun: false, cache: false, logger: false });
    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    jest.spyOn(RedisLockService, 'current', 'get').mockReturnValue({
      withLock: async (_key: string, _ttl: number, action: () => Promise<unknown>) => action(),
    } as RedisLockService);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const wrapped = `0:${legacy(createHash('sha256').update(OLD_KEY).digest(), DEK)}`;
    const good = await runner.manager.getRepository(Workspace).save({ name: 'e2e-upgrade', dek: wrapped });
    const bad = await runner.manager.getRepository(Workspace).save({ name: 'e2e-unreadable-upgrade', dek: unavailable });
    workspaceId = good.id;
    badWorkspaceId = bad.id;
    const [workflow] = await runner.manager.query<{ id: string }[]>(
      'INSERT INTO workflows (name, "filePath", "workspaceId", content) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
      ['upgrade', 'upgrade.yaml', workspaceId, JSON.stringify({ jobs: { scan: { run: 'tool', config: { token: legacy(DEK, 'workflow-token'), retries: 2 } } } })],
    );
    workflowId = workflow.id;
    const [integration] = await runner.manager.query<{ id: string }[]>(
      'INSERT INTO integrations (name, "appType", category, "workspaceId", config) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id',
      ['upgrade', 'test', 'test', workspaceId, JSON.stringify({ token: legacy(DEK, 'integration-token'), unreadable: unavailable, plain: 'plain-secret' })],
    );
    integrationId = integration.id;
    await runner.query(
      'INSERT INTO integrations (name, "appType", category, "workspaceId", config) VALUES ($1, $2, $3, $4, $5::jsonb)',
      ['bad-upgrade', 'test', 'test', badWorkspaceId, JSON.stringify({ token: unavailable })],
    );

    // Use real SQL/DEK resolution, but restrict reads to this transaction's
    // fixtures. Key rotation cannot rewrite other concurrently running suites.
    // UPDATE statements are executed unchanged, including their CAS predicate.
    const scopedSource = {
      query: async (sql: string, parameters: unknown[] = []): Promise<unknown> => {
        if (sql.startsWith('SELECT')) {
          const scopeColumn = sql.includes('FROM workspaces') ? 'id' : '"workspaceId"';
          return runner.query(`${sql} AND ${scopeColumn} = ANY($1::uuid[])`, [[workspaceId, badWorkspaceId]]);
        }
        if (conflictId && sql.startsWith('UPDATE "workflows"') && parameters[1] === conflictId) {
          await runner.query('UPDATE workflows SET content = $1::jsonb WHERE id = $2', [JSON.stringify({ jobs: {}, name: 'concurrent edit' }), conflictId]);
          conflictId = undefined;
        }
        return runner.query(sql, parameters);
      },
    };
    upgrade = new EncryptionUpgradeService(
      scopedSource as DataSource,
      new WorkspaceEncryptionService(runner.manager.getRepository(Workspace)),
    );
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
    await runner?.release();
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (originalKeys === undefined) delete process.env.ENCRYPTION_KEYS;
    else process.env.ENCRYPTION_KEYS = originalKeys;
    jest.restoreAllMocks();
  });

  it('rewraps DEKs and nested JSONB secrets without touching unreadable or plain values', async () => {
    const counts = await upgrade.upgrade();
    expect(counts).toMatchObject({ rewrapped: 1, reencrypted: 2, unreadable: 3 });
    const [workspace] = await runner.manager.query<{ dek: string }[]>('SELECT dek FROM workspaces WHERE id = $1', [workspaceId]);
    const [bad] = await runner.manager.query<{ dek: string }[]>('SELECT dek FROM workspaces WHERE id = $1', [badWorkspaceId]);
    process.env.ENCRYPTION_KEYS = NEW_KEY;
    expect(workspace.dek).toMatch(/^v2:/);
    expect(unwrapDEK(workspace.dek).equals(DEK)).toBe(true);
    expect(bad.dek).toBe(unavailable);
    const [workflow] = await runner.manager.query<{ content: { jobs: { scan: { config: { token: string; retries: number } } } } }[]>('SELECT content FROM workflows WHERE id = $1', [workflowId]);
    const [integration] = await runner.manager.query<{ config: { token: string; unreadable: string; plain: string } }[]>('SELECT config FROM integrations WHERE id = $1', [integrationId]);
    expect(decryptWithDEK(workflow.content.jobs.scan.config.token, DEK)).toBe('workflow-token');
    expect(workflow.content.jobs.scan.config.retries).toBe(2);
    expect(decryptWithDEK(integration.config.token, DEK)).toBe('integration-token');
    expect(integration.config.unreadable).toBe(unavailable);
    expect(integration.config.plain).toBe('plain-secret');
  });

  it('does not rewrite current values on another run', async () => {
    expect(await upgrade.upgrade()).toMatchObject({ rewrapped: 0, reencrypted: 0, unreadable: 3 });
  });

  it('retains an edit made between reading a JSONB value and updating it', async () => {
    const [workflow] = await runner.manager.query<{ id: string }[]>(
      'INSERT INTO workflows (name, "filePath", "workspaceId", content) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
      ['conflict', 'conflict.yaml', workspaceId, JSON.stringify({ jobs: { scan: { config: { token: legacy(DEK, 'old-token') } } } })],
    );
    conflictId = workflow.id;
    expect(await upgrade.upgrade()).toMatchObject({ rewrapped: 0, reencrypted: 0 });
    const [saved] = await runner.manager.query<{ content: unknown }[]>('SELECT content FROM workflows WHERE id = $1', [workflow.id]);
    expect(saved.content).toEqual({ jobs: {}, name: 'concurrent edit' });
  });
});
