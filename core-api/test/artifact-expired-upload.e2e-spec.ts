import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { ArtifactExpiredUploadService } from '@/modules/artifacts/artifact-expired-upload.service';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactUploadCompletionService } from '@/modules/artifacts/artifact-upload-completion.service';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Expired private artifact upload (e2e)', () => {
  let app: TestApp;
  let storage: StorageService;
  let completion: ArtifactUploadCompletionService;
  let reservation: ArtifactUploadReservationService;
  let expiry: ArtifactExpiredUploadService;
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
    expiry = new ArtifactExpiredUploadService(app.dataSource, storage, quota);
  });

  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id', ['Artifact expiration ' + randomUUID()],
    );
    workspaceId = workspace.id;
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
});
