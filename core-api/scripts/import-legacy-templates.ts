import 'reflect-metadata';
import { dataSourceOptions } from '../src/database/database-config';
import { ArtifactQuotaService } from '../src/modules/artifacts/artifact-quota.service';
import { ArtifactUploadCompletionService } from '../src/modules/artifacts/artifact-upload-completion.service';
import { ArtifactUploadReservationService } from '../src/modules/artifacts/artifact-upload-reservation.service';
import { EVENT_CATALOG } from '../src/modules/event-bridge/contracts/event-catalog';
import { EventBridgeService } from '../src/modules/event-bridge/publishing/event-bridge.service';
import { RustFsClient } from '../src/modules/storage/rustfs.client';
import { StorageService } from '../src/modules/storage/storage.service';
import { LegacyTemplateImportService } from '../src/modules/templates/legacy-template-import.service';
import { TemplateArtifactService } from '../src/modules/templates/template-artifact.service';
import { RedisService } from '../src/services/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const workspaceArg = args.find(arg => arg.startsWith('--workspace='));
  const workspaceId = workspaceArg?.slice('--workspace='.length);
  const allowed = new Set(['--apply', '--legacy-uploads-drained', workspaceArg]);
  if (args.some(arg => !allowed.has(arg)) || (workspaceArg !== undefined && !isUUID(workspaceId))) throw new Error('Usage: task api:templates:import -- [--workspace=UUID] [--apply --legacy-uploads-drained]');
  if (apply && !args.includes('--legacy-uploads-drained')) throw new Error('Drain legacy uploads and let all issued upload URLs expire before applying the import');

  // No AppModule, consumers, schedulers, automatic migrations or extension DDL.
  if (dataSourceOptions.type !== 'postgres') throw new Error('Template import requires the configured PostgreSQL database');
  const database = new DataSource({ ...dataSourceOptions, synchronize: false, migrationsRun: false, dropSchema: false, installExtensions: false, cache: false });
  const config = new ConfigService(process.env);
  const client = new RustFsClient(config);
  let redis: RedisService | undefined;
  try {
    await database.initialize();
    const storage = new StorageService(client, config, database);
    if (apply) await storage.onModuleInit();
    const quota = new ArtifactQuotaService();
    redis = new RedisService(config);
    await redis.onModuleInit();
    const events = new EventBridgeService(redis, EVENT_CATALOG);
    const writer = new TemplateArtifactService(database, new ArtifactUploadReservationService(database, storage, quota), new ArtifactUploadCompletionService(database, storage, quota), quota, storage, events);
    const results = await new LegacyTemplateImportService(database, storage, writer).run({ workspaceId, apply });
    process.stdout.write(JSON.stringify({ mode: apply ? 'apply' : 'preview', results }, null, 2) + '\n');
    if (results.some(result => !['eligible', 'imported', 'already_imported'].includes(result.status))) process.exitCode = 1;
  } finally {
    if (database.isInitialized) await database.destroy();
    await redis?.onModuleDestroy();
    client.getClient().destroy();
    client.getPresignClient().destroy();
  }
}

void main().catch(() => {
  process.stderr.write('Template import failed. Check configuration and the preview report; no legacy data is deleted.\n');
  process.exitCode = 1;
});
