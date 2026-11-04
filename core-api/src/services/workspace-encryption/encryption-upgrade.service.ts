import {
  encrypt,
  isEncryptedWithActiveKek,
  parseCiphertext,
} from '@/common/utils/encryption.util';
import {
  decryptWithDEK,
  encryptWithDEK,
  needsReencryption,
  unwrapDEK,
  wrapDEK,
} from '@/common/utils/workspace-encryption.util';
import { Lock } from '@/services/redis/lock.decorator';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkspaceEncryptionService } from './workspace-encryption.service';

type Reencrypt = (secret: string) => string;
interface SecretColumn {
  table: string;
  column: string;
  jsonb: boolean;
  systemWide?: boolean;
  map: (value: unknown, reencrypt: Reencrypt) => unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Current credential writers encrypt top-level string fields in configs.
const mapConfigStrings = (value: unknown, reencrypt: Reencrypt): unknown =>
  isObject(value)
    ? Object.fromEntries(Object.entries(value).map(([field, entry]) => [
        field,
        typeof entry === 'string' ? reencrypt(entry) : entry,
      ]))
    : value;

const mapWorkflow = (value: unknown, reencrypt: Reencrypt): unknown => {
  if (!isObject(value)) return value;
  const mapJob = (job: unknown): unknown =>
    isObject(job) && isObject(job.config)
      ? { ...job, config: mapConfigStrings(job.config, reencrypt) }
      : job;
  // Older workflows stored jobs in an array; newer ones use a job-id map.
  if (Array.isArray(value.jobs)) {
    return { ...value, jobs: value.jobs.map(mapJob) };
  }
  if (isObject(value.jobs)) {
    return {
      ...value,
      jobs: Object.fromEntries(Object.entries(value.jobs).map(([id, job]) => [id, mapJob(job)])),
    };
  }
  return value;
};

/** Stored ciphertext locations, including group-created inline workflows. */
const SECRET_COLUMNS: SecretColumn[] = [
  {
    table: 'agent_llm_configs', column: 'apiKey', jsonb: false,
    map: (value, reencrypt) => typeof value === 'string' ? reencrypt(value) : value,
  },
  {
    table: 'agent_configs', column: 'searchProviders', jsonb: true,
    map: (value, reencrypt) => Array.isArray(value)
      ? value.map((provider: unknown) => isObject(provider) && typeof provider.apiKey === 'string'
          ? { ...provider, apiKey: reencrypt(provider.apiKey) }
          : provider)
      : value,
  },
  { table: 'integrations', column: 'config', jsonb: true, map: mapConfigStrings },
  { table: 'tool_config_profiles', column: 'config', jsonb: true, map: mapConfigStrings },
  { table: 'workflows', column: 'content', jsonb: true, map: mapWorkflow },
  {
    table: 'system_configs', column: 'settings', jsonb: true, systemWide: true,
    map: (value, reencrypt) => isObject(value) && isObject(value.mailServer) && typeof value.mailServer.password === 'string'
      ? { ...value, mailServer: { ...value.mailServer, password: reencrypt(value.mailServer.password) } }
      : value,
  },
];

const affectedRows = (result: unknown): number =>
  Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;

interface UpgradeCounts {
  rewrapped: number;
  reencrypted: number;
  unreadable: number;
  conflicted: number;
}

/**
 * Upgrades recognized stored ciphertext at boot. Unreadable values are retained;
 * conditional updates preserve concurrent edits. This is a data-format rewrite:
 * older application versions cannot read the new values after it runs.
 */
@Injectable()
export class EncryptionUpgradeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EncryptionUpgradeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly workspaceEncryption: WorkspaceEncryptionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.upgrade();
    } catch {
      // Query errors can carry credential parameters. Do not log their values.
      this.logger.error(
        'Encryption upgrade did not complete; retain existing encryption keys and the pre-upgrade database backup',
      );
    }
  }

  @Lock('encryption-upgrade', { ttl: 10 * 60_000 })
  async upgrade(): Promise<UpgradeCounts | undefined> {
    const counts: UpgradeCounts = { rewrapped: 0, reencrypted: 0, unreadable: 0, conflicted: 0 };
    await this.rewrapDeks(counts);
    for (const column of SECRET_COLUMNS) await this.reencryptColumn(column, counts);
    if (counts.rewrapped || counts.reencrypted) {
      this.logger.log(
        `Encryption upgrade rewrote ${counts.rewrapped} workspace DEK(s) and ${counts.reencrypted} credential value(s)`,
      );
    }
    if (counts.unreadable) {
      this.logger.warn(
        `Encryption upgrade left ${counts.unreadable} unreadable record(s) unchanged; retain every key they may need`,
      );
    }
    if (counts.conflicted) {
      this.logger.warn(
        `Encryption upgrade skipped ${counts.conflicted} concurrently changed row(s); they require a later pass`,
      );
    }
    return counts;
  }

  private async rewrapDeks(counts: UpgradeCounts): Promise<void> {
    const rows: { id: string; dek: string }[] = await this.dataSource.query(
      'SELECT id, dek FROM workspaces WHERE dek IS NOT NULL',
    );
    for (const { id, dek } of rows) {
      let rewrapped: string;
      try {
        const plain = unwrapDEK(dek);
        if (isEncryptedWithActiveKek(dek)) continue;
        rewrapped = wrapDEK(plain);
      } catch {
        counts.unreadable++;
        continue;
      }
      const result: unknown = await this.dataSource.query(
        'UPDATE workspaces SET dek = $1 WHERE id = $2 AND dek = $3',
        [rewrapped, id, dek],
      );
      if (affectedRows(result)) counts.rewrapped++;
      else counts.conflicted++;
    }
  }

  private async reencryptColumn(
    { table, column, jsonb, systemWide, map }: SecretColumn,
    counts: UpgradeCounts,
  ): Promise<void> {
    const workspace = systemWide ? 'NULL' : '"workspaceId"';
    const rows: { id: string; workspaceId: string | null; value: unknown }[] =
      await this.dataSource.query(
        `SELECT id, ${workspace} AS "workspaceId", "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`,
      );
    for (const { id, workspaceId, value } of rows) {
      let dek: Buffer | null;
      try {
        dek = workspaceId ? await this.workspaceEncryption.getDEK(workspaceId) : null;
      } catch {
        // A broken DEK must not prevent other workspaces from being upgraded.
        counts.unreadable++;
        continue;
      }
      let changed = 0;
      const next = map(value, (secret) => {
        if (!parseCiphertext(secret)) return secret;
        try {
          // Verify current values too, so a corrupt GCM value is reported.
          const plain = decryptWithDEK(secret, dek);
          if (!needsReencryption(secret, dek)) return secret;
          const encrypted = dek ? encryptWithDEK(plain, dek) : encrypt(plain);
          changed++;
          return encrypted;
        } catch {
          counts.unreadable++;
          return secret;
        }
      });
      if (!changed) continue;
      const cast = jsonb ? '::jsonb' : '';
      const serialize = (entry: unknown) => jsonb ? JSON.stringify(entry) : entry;
      const result: unknown = await this.dataSource.query(
        `UPDATE "${table}" SET "${column}" = $1${cast} WHERE id = $2 AND "${column}" = $3${cast}`,
        [serialize(next), id, serialize(value)],
      );
      if (affectedRows(result)) counts.reencrypted += changed;
      else counts.conflicted++;
    }
  }
}
