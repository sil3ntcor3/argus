import { ARTIFACT_BUCKET, ARTIFACT_UPLOAD_TTL_SECONDS, workspaceArtifactKey, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { ArtifactStagingSweepService, ARTIFACT_STAGING_CURSOR } from '@/modules/artifacts/artifact-staging-sweep.service';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { ArtifactUploadCompletionService } from '@/modules/artifacts/artifact-upload-completion.service';
import { WorkspaceStorageUsage } from '@/modules/artifacts/entities/workspace-storage-usage.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { RustFsClient } from '@/modules/storage/rustfs.client';
import { StorageService } from '@/modules/storage/storage.service';
import { RedisService } from '@/services/redis/redis.service';
import type { DeleteObjectsCommandInput, ListObjectsV2CommandInput, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUser, createWorkspace, type TestUser } from './helpers/workspace';

describe('Orphaned artifact staging cleanup (e2e)', () => {
  let app: TestApp;
  let storage: StorageService;
  let redis: RedisService;
  let sweep: ArtifactStagingSweepService;
  let workspaceId: string;
  let keys: string[];
  let s3: S3Client;
  let cursorKey: string;
  let owner: TestUser;
  const middlewareName = 'scopeLateStagingE2e';

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    storage = app.app.get(StorageService);
    redis = app.app.get(RedisService);
    sweep = app.app.get(ArtifactStagingSweepService);
    s3 = app.app.get(RustFsClient).getClient();
    owner = await createUser(app.server);
  });

  beforeEach(async () => {
    workspaceId = (await createWorkspace(app.server, owner)).id;
    keys = [];
    cursorKey = `${ARTIFACT_STAGING_CURSOR}:test:${workspaceId}`;
    const mapKey = (key: string) => key === ARTIFACT_STAGING_CURSOR ? cursorKey : key;
    jest.spyOn(redis, 'get').mockImplementation(key => redis.cacheClient.get(mapKey(key)));
    jest.spyOn(redis, 'set').mockImplementation((key, value) => redis.cacheClient.set(mapKey(key), String(value)));
    jest.spyOn(redis, 'del').mockImplementation(key => redis.client.del(mapKey(key)));
    // E2E Postgres may be isolated while S3 and Redis still belong to the local app.
    const prefix = `workspaces/${workspaceId}/`;
    s3.middlewareStack.add((next, context) => async args => {
      if (context.commandName === 'ListObjectsV2Command') {
        const input = args.input as ListObjectsV2CommandInput;
        if (input.Bucket === ARTIFACT_BUCKET && input.Prefix === 'workspaces/') input.Prefix = prefix;
      }
      if (context.commandName === 'DeleteObjectsCommand') {
        const input = args.input as DeleteObjectsCommandInput;
        if (input.Bucket === ARTIFACT_BUCKET && input.Delete?.Objects?.some(object => !object.Key?.startsWith(prefix))) {
          throw new Error('Staging fixture attempted to delete a foreign key');
        }
      }
      return next(args);
    }, { step: 'initialize', name: middlewareName });
  });

  afterEach(async () => {
    if (!storage || !keys) return;
    try {
      for (let offset = 0; offset < keys.length; offset += 24) {
        await Promise.all(keys.slice(offset, offset + 24).map(key => storage.deleteFile(key, ARTIFACT_BUCKET)));
      }
      await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
      await redis.del(cursorKey);
    } finally {
      s3.middlewareStack.remove(middlewareName);
      jest.restoreAllMocks();
    }
  });

  afterAll(async () => {
    if (!app) return;
    try {
      if (owner) await cleanupE2eData(app.dataSource, { userIds: [owner.userId] });
    } finally {
      await closeTestApp(app.app);
    }
  });

  const put = async (key: string) => {
    keys.push(key);
    await storage.uploadFile(key, Buffer.from('file'), ARTIFACT_BUCKET, 'text/plain');
    return key;
  };
  const head = (key: string) => storage.headObject(ARTIFACT_BUCKET, key);
  const aged = () => new Date(Date.now() + 2_000);
  const keep = (key: string) => expect(head(key)).resolves.toMatchObject({ contentLength: 4 });
  const removed = (key: string) => expect(head(key)).rejects.toMatchObject({ status: 404 });

  it('reaps a late staging write on a later pass without deleting a tracked upload or final file', async () => {
    const id = randomUUID();
    const expiredId = randomUUID();
    const orphan = workspaceArtifactUploadKey(workspaceId, expiredId);
    const final = await put(workspaceArtifactKey(workspaceId, expiredId));
    const pending = await put(workspaceArtifactUploadKey(workspaceId, id));
    const malformed = await put(`workspaces/${workspaceId}/not-an-artifact/upload`);
    await app.dataSource.getRepository(WorkspaceArtifact).insert({
      id, workspaceId, name: 'pending.txt', mimeType: 'text/plain', sizeBytes: '4',
      objectKey: workspaceArtifactKey(workspaceId, id), source: 'upload', status: 'pending',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    await sweep.sweepPage(aged()); // Expiry already removed the first upload and row.
    await put(orphan); // A request that started earlier arrives after that cleanup.
    await sweep.sweepPage(new Date(Date.now() - ARTIFACT_UPLOAD_TTL_SECONDS * 1000));
    await keep(orphan);
    await sweep.sweepPage(aged());
    await removed(orphan);
    await keep(pending);
    await keep(final);
    await keep(malformed);

    await put(orphan); // A later finishing request is found on a new pass too.
    await sweep.sweepPage(aged());
    await removed(orphan);

    // An absent workspace alone is insufficient evidence for deleting final bytes.
    await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    await sweep.sweepPage(aged());
    await keep(final);
  });

  it('retries final and staging cleanup after the workspace and file rows are deleted', async () => {
    const id = randomUUID();
    const final = await put(workspaceArtifactKey(workspaceId, id));
    const staging = await put(workspaceArtifactUploadKey(workspaceId, id));
    await app.dataSource.getRepository(WorkspaceArtifact).insert({
      id, workspaceId, name: 'ready.txt', mimeType: 'text/plain', sizeBytes: '4',
      objectKey: final, source: 'upload', status: 'ready', createdByUserId: owner.userId,
    });
    const unavailable = jest.spyOn(storage, 'deleteWorkspaceArtifacts').mockRejectedValueOnce(new Error('fixture outage'));
    await request(app.server).delete(`/api/workspaces/${workspaceId}`)
      .set(wsHeaders(owner.cookie, workspaceId)).expect(200);
    expect(unavailable).toHaveBeenCalledWith(workspaceId);
    unavailable.mockRestore();
    await keep(final);
    await keep(staging);
    await sweep.sweepPage(aged());
    await removed(final);
    await removed(staging);
  });

  it('reclaims expired ready staging bytes while preserving the final file and quota', async () => {
    const quota = app.app.get(ArtifactQuotaService);
    const reservations = new ArtifactUploadReservationService(app.dataSource, storage, quota);
    const completion = new ArtifactUploadCompletionService(app.dataSource, storage, quota);
    const { artifact, upload } = await reservations.reserveUpload({
      workspaceId, createdByUserId: owner.userId, name: 'ready.txt', contentType: 'text/plain', sizeBytes: 4,
    });
    const staging = await put(workspaceArtifactUploadKey(workspaceId, artifact.id));
    keys.push(artifact.objectKey);
    await completion.completeUpload({ workspaceId, userId: owner.userId, artifactId: artifact.id });
    await sweep.sweepPage(aged());
    await keep(staging);

    const afterDeadline = new Date(upload.expiresAt.getTime() + 1_000);
    await sweep.sweepPage(afterDeadline);
    await removed(staging);
    await keep(artifact.objectKey);
    await put(staging);
    await sweep.sweepPage(afterDeadline);
    await removed(staging);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).findOneBy({ id: artifact.id }))
      .toMatchObject({ status: 'ready', sizeBytes: '4' });
    expect(await app.dataSource.getRepository(WorkspaceStorageUsage).findOneBy({ workspaceId }))
      .toMatchObject({ usedBytes: '4', reservedBytes: '0' });
    const response = await request(app.server).get(`/api/artifacts/${artifact.id}/download`)
      .set(wsHeaders(owner.cookie, workspaceId)).expect(200);
    const download = await fetch((response.body as { url: string }).url);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('file');
  });

  it('retains tracked staging for unknown/live deadlines and pending/deleted files', async () => {
    const fixtures = [
      ['ready', null], ['ready', new Date(Date.now() + 60_000)],
      ['pending', new Date(0)], ['deleted', new Date(0)],
    ] as const;
    const staging: string[] = [];
    for (const [status, expiresAt] of fixtures) {
      const id = randomUUID();
      staging.push(await put(workspaceArtifactUploadKey(workspaceId, id)));
      await app.dataSource.getRepository(WorkspaceArtifact).insert({
        id, workspaceId, name: 'tracked.txt', mimeType: 'text/plain', sizeBytes: '4',
        objectKey: workspaceArtifactKey(workspaceId, id), source: 'upload', status, expiresAt,
      });
    }
    await sweep.sweepPage(aged());
    for (const key of staging) await keep(key);
  });

  it('preserves a live workspace even when its ID appears in the deletion audit log', async () => {
    const final = await put(workspaceArtifactKey(workspaceId, randomUUID()));
    await app.dataSource.query(
      `INSERT INTO audit_events ("eventId","workspaceId","resourceId","resourceType",action,outcome)
       VALUES ($1,$2,$2,'workspace','workspace.deleted','success')`,
      [randomUUID(), workspaceId],
    );
    await sweep.sweepPage(aged());
    await keep(final);
  });

  it('saves the last key of a full page and wraps to catch late writes behind it', async () => {
    const first = await put(workspaceArtifactUploadKey(workspaceId, '10000000-0000-4000-8000-000000000001'));
    const last = await put(workspaceArtifactUploadKey(workspaceId, '20000000-0000-4000-8000-000000000002'));
    for (let offset = 0; offset < 499; offset += 24) {
      await Promise.all(Array.from({ length: Math.min(24, 499 - offset) }, (_, i) =>
        put(`workspaces/${workspaceId}/0-${offset + i}`)));
    }
    await sweep.sweepPage(aged());
    expect(await redis.get(cursorKey)).toBe(first);
    await removed(first);
    await keep(last);
    const behind = await put(workspaceArtifactUploadKey(workspaceId, '05000000-0000-4000-8000-000000000003'));
    await sweep.sweepPage(aged());
    await removed(first);
    await keep(behind);
    await removed(last);
    expect(await redis.get(cursorKey)).toBeNull();
    await sweep.sweepPage(aged());
    await removed(behind);
  });
});
