import { ARTIFACT_BUCKET, workspaceArtifactKey, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { ArtifactExpiredUploadService } from '@/modules/artifacts/artifact-expired-upload.service';
import { ArtifactExpirySweepService, ARTIFACT_EXPIRY_CURSOR } from '@/modules/artifacts/artifact-expiry-sweep.service';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactUploadCompletionService } from '@/modules/artifacts/artifact-upload-completion.service';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { RedisService } from '@/services/redis/redis.service';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Expired private artifact upload (e2e)', () => {
  let app: TestApp;
  let storage: StorageService;
  let completion: ArtifactUploadCompletionService;
  let reservation: ArtifactUploadReservationService;
  let expiry: ArtifactExpiredUploadService;
  let sweep: ArtifactExpirySweepService;
  let redis: RedisService;
  let cursorKey: string;
  let workspaceId: string;
  let userId: string;
  let artifact: WorkspaceArtifact;
  let staging: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    storage = app.app.get(StorageService);
    const quota = new ArtifactQuotaService();
    reservation = new ArtifactUploadReservationService(app.dataSource, storage, quota);
    completion = new ArtifactUploadCompletionService(app.dataSource, storage, quota);
    expiry = app.app.get(ArtifactExpiredUploadService);
    sweep = app.app.get(ArtifactExpirySweepService);
    redis = app.app.get(RedisService);
  });

  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id', ['Artifact expiration ' + randomUUID()],
    );
    workspaceId = workspace.id;
    // The integration database can be isolated while Redis is still shared.
    cursorKey = `${ARTIFACT_EXPIRY_CURSOR}:test:${workspaceId}`;
    const mapKey = (key: string) => key === ARTIFACT_EXPIRY_CURSOR ? cursorKey : key;
    jest.spyOn(redis, 'get').mockImplementation(key => redis.cacheClient.get(mapKey(key)));
    jest.spyOn(redis, 'set').mockImplementation((key, value) => redis.cacheClient.set(mapKey(key), String(value)));
    jest.spyOn(redis, 'del').mockImplementation(key => redis.client.del(mapKey(key)));
    const [user] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO users (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id',
      ['Artifact author', randomUUID() + '@example.test'],
    );
    userId = user.id;
    ({ artifact } = await reservation.reserveUpload({
      workspaceId, createdByUserId: userId, name: 'expiry.txt', contentType: 'text/plain', sizeBytes: 3,
    }));
    staging = workspaceArtifactUploadKey(workspaceId, artifact.id);
    await storage.uploadFile(staging, Buffer.from('one'), ARTIFACT_BUCKET, 'text/plain');
  });

  afterEach(async () => {
    if (artifact && staging) {
      await Promise.all([staging, artifact.objectKey].map(key => storage.deleteFile(key, ARTIFACT_BUCKET)));
    }
    if (workspaceId) await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    if (userId) await app.dataSource.query('DELETE FROM users WHERE id=$1', [userId]);
    if (cursorKey) await redis.del(cursorKey);
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  const input = () => ({ workspaceId, artifactId: artifact.id });
  const repo = () => app.dataSource.getRepository(WorkspaceArtifact);
  const record = () => repo().findOneBy({ id: artifact.id });
  const expired = () => repo().update(artifact.id, { expiresAt: new Date(Date.now() - 20 * 60_000) });
  const usage = async () => (await app.dataSource.query<{ usedBytes: string; reservedBytes: string }[]>(
    'SELECT "usedBytes","reservedBytes" FROM workspace_storage_usage WHERE "workspaceId"=$1', [workspaceId],
  ))[0];

  it('leaves live reservations, recently expired forms, and ready files untouched', async () => {
    await expect(expiry.reclaim(input())).resolves.toBe(false);
    await repo().update(artifact.id, { expiresAt: new Date(Date.now() - 60_000) });
    await expect(expiry.reclaim(input())).resolves.toBe(false);
    await repo().update(artifact.id, { expiresAt: artifact.expiresAt });
    await completion.completeUpload({ ...input(), userId });
    await expired();
    await expect(expiry.reclaim(input())).resolves.toBe(false);
    expect(await record()).toMatchObject({ status: 'ready' });
    expect(await usage()).toEqual({ usedBytes: '3', reservedBytes: '0' });
    await expect(storage.headObject(ARTIFACT_BUCKET, artifact.objectKey)).resolves.toMatchObject({ contentLength: 3 });
  });

  it('removes staging and an orphaned final copy and releases the reservation once', async () => {
    await storage.publishArtifactUpload({ ...input(), contentType: 'text/plain', sizeBytes: 3 });
    await expired();
    await expect(expiry.reclaim({ ...input(), workspaceId: randomUUID() })).resolves.toBe(false);
    const outcomes = await Promise.all([expiry.reclaim(input()), expiry.reclaim(input())]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await record()).toBeNull();
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '0' });
    for (const key of [staging, artifact.objectKey]) {
      await expect(storage.headObject(ARTIFACT_BUCKET, key)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('retains quota and the record until object cleanup can succeed', async () => {
    await expired();
    const outage = jest.spyOn(storage, 'deleteArtifactUploadObjects').mockRejectedValueOnce(new Error('fixture storage outage'));
    try {
      await expect(expiry.reclaim(input())).rejects.toThrow('fixture storage outage');
    } finally {
      outage.mockRestore();
    }
    expect(await record()).toMatchObject({ status: 'pending' });
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '3' });
    await expect(expiry.reclaim(input())).resolves.toBe(true);
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '0' });
  });

  it('selects only pending browser uploads past the expiry grace period', async () => {
    const reclaim = jest.spyOn(expiry, 'reclaim');
    await sweep.sweepPage();
    await repo().update(artifact.id, { expiresAt: new Date(Date.now() - 60_000) });
    await sweep.sweepPage();
    expect(reclaim).not.toHaveBeenCalled();
    await expired();
    const agentId = randomUUID();
    const readyId = randomUUID();
    await repo().insert([
      { id: agentId, workspaceId, name: 'agent.txt', mimeType: 'text/plain', sizeBytes: '0',
        objectKey: workspaceArtifactKey(workspaceId, agentId), source: 'agent', status: 'pending', expiresAt: new Date(0) },
      { id: readyId, workspaceId, name: 'ready.txt', mimeType: 'text/plain', sizeBytes: '0',
        objectKey: workspaceArtifactKey(workspaceId, readyId), source: 'upload', status: 'ready', expiresAt: new Date(0) },
    ]);
    await sweep.sweepPage();
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(reclaim).toHaveBeenCalledWith(input());
    expect(await record()).toBeNull();
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '0' });
    await expect(storage.headObject(ARTIFACT_BUCKET, staging)).rejects.toMatchObject({ status: 404 });
  });

  it('reclaims a later reservation while the oldest artifact row is locked', async () => {
    await expired();
    const { artifact: later } = await reservation.reserveUpload({
      workspaceId, createdByUserId: userId, name: 'later.txt', contentType: 'text/plain', sizeBytes: 3,
    });
    await repo().update(later.id, { expiresAt: new Date(Date.now() - 19 * 60_000) });
    const blocking = app.dataSource.createQueryRunner();
    await blocking.connect();
    await blocking.startTransaction();
    let sweepWork: Promise<void> | undefined;
    try {
      await blocking.query('SELECT id FROM artifacts WHERE id=$1 FOR UPDATE', [artifact.id]);
      sweepWork = sweep.sweepPage();
      expect(await Promise.race([sweepWork.then(() => true), wait(6_000, false, { ref: false })])).toBe(true);
      expect(await record()).toMatchObject({ status: 'pending' });
      expect(await repo().findOneBy({ id: later.id })).toBeNull();
      expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '3' });
    } finally {
      await blocking.rollbackTransaction();
      await blocking.release();
      await sweepWork;
    }
    await sweep.sweepPage();
    expect(await record()).toBeNull();
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '0' });
  });

  it('bounds a page, advances past a failed reservation, and retries it after wrapping', async () => {
    const expiresAt = new Date(Date.now() - 20 * 60_000);
    await repo().update(artifact.id, { expiresAt: new Date(expiresAt.getTime() - 1_000) });
    const tiedIds = Array.from({ length: 25 }, () => randomUUID()).sort();
    await repo().insert(tiedIds.map(id => ({
      id, workspaceId, name: 'queued.txt', mimeType: 'text/plain', sizeBytes: '0',
      objectKey: workspaceArtifactKey(workspaceId, id), source: 'upload', status: 'pending', expiresAt,
    })));
    const reclaim = jest.spyOn(expiry, 'reclaim').mockResolvedValue(false)
      .mockRejectedValueOnce(new Error('fixture storage outage'));
    await sweep.sweepPage();
    expect(reclaim).toHaveBeenCalledTimes(25);
    expect(reclaim).toHaveBeenNthCalledWith(1, input());
    await sweep.sweepPage();
    expect(reclaim).toHaveBeenCalledTimes(26);
    expect(reclaim).toHaveBeenNthCalledWith(26, { workspaceId, artifactId: tiedIds[24] });
    await sweep.sweepPage();
    expect(reclaim).toHaveBeenNthCalledWith(27, input());
  });
});
