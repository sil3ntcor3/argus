import {
  workspaceArtifactKey, workspaceArtifactUploadKey,
} from '@/common/constants/artifact-storage';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { StorageService } from '@/modules/storage/storage.service';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private artifact upload reservation (e2e)', () => {
  let app: TestApp;
  let reservations: ArtifactUploadReservationService;
  let workspaceId: string;
  let createdByUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    reservations = new ArtifactUploadReservationService(
      app.dataSource, app.app.get(StorageService), new ArtifactQuotaService(),
    );
  });

  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
      ['Artifact reservation ' + randomUUID()],
    );
    workspaceId = workspace.id;
    const [user] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO users (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id',
      ['Artifact author', randomUUID() + '@example.test'],
    );
    createdByUserId = user.id;
  });

  afterEach(async () => {
    if (workspaceId) await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    if (createdByUserId) await app.dataSource.query('DELETE FROM users WHERE id=$1', [createdByUserId]);
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  const input = () => ({
    workspaceId, createdByUserId, name: 'Display name.txt', contentType: 'text/plain', sizeBytes: 7,
  });

  const rows = () => app.dataSource.query<{
    id: string; status: string; objectKey: string; expiresAt: Date; sizeBytes: string;
  }[]>(
    'SELECT id,status,"objectKey","expiresAt","sizeBytes" FROM artifacts WHERE "workspaceId"=$1',
    [workspaceId],
  );

  const usage = () => app.dataSource.query<{ usedBytes: string; reservedBytes: string }[]>(
    'SELECT "usedBytes","reservedBytes" FROM workspace_storage_usage WHERE "workspaceId"=$1',
    [workspaceId],
  );

  it('reserves bytes with the pending row and persists the exact signed deadline', async () => {
    const { artifact, upload } = await reservations.reserveUpload(input());
    expect(artifact).toMatchObject({
      workspaceId, createdByUserId, status: 'pending', name: 'Display name.txt',
      objectKey: workspaceArtifactKey(workspaceId, artifact.id), sizeBytes: '7',
      expiresAt: upload.expiresAt,
    });
    expect(upload.fields.key).toBe(workspaceArtifactUploadKey(workspaceId, artifact.id));
    expect(await rows()).toEqual([{
      id: artifact.id, status: 'pending', objectKey: artifact.objectKey,
      expiresAt: upload.expiresAt, sizeBytes: '7',
    }]);
    expect(await usage()).toEqual([{ usedBytes: '0', reservedBytes: '7' }]);
  });

  it('allows only one pending file when two simultaneous requests would exceed quota', async () => {
    await app.dataSource.query(
      'INSERT INTO workspace_storage_usage ("workspaceId","quotaBytes") VALUES ($1,10)',
      [workspaceId],
    );
    const outcomes = await Promise.allSettled([
      reservations.reserveUpload(input()), reservations.reserveUpload(input()),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({
      reason: expect.any(ConflictException),
    });
    expect(await rows()).toHaveLength(1);
    expect(await usage()).toEqual([{ usedBytes: '0', reservedBytes: '7' }]);
  });

  it('rolls back both writes when the form expires during quota accounting', async () => {
    const quota = new ArtifactQuotaService();
    const originalQuota = new ArtifactQuotaService();
    const afterDeadline = Date.now() + 16 * 60 * 1000;
    let clock: jest.SpyInstance<number, []> | undefined;
    jest.spyOn(quota, 'reserve').mockImplementation(async (...args) => {
      const result = await originalQuota.reserve(...args);
      clock = jest.spyOn(Date, 'now').mockReturnValue(afterDeadline);
      return result;
    });
    const service = new ArtifactUploadReservationService(
      app.dataSource, app.app.get(StorageService), quota,
    );

    try {
      await expect(service.reserveUpload(input())).rejects.toThrow('policy already expired');
    } finally {
      clock?.mockRestore();
    }
    expect(await rows()).toEqual([]);
    expect(await usage()).toEqual([]);
  });

  it('rejects a blank or control-character display name before reserving anything', async () => {
    for (const name of ['  ', 'bad\nname.txt']) {
      await expect(reservations.reserveUpload({ ...input(), name }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    expect(await rows()).toEqual([]);
    expect(await usage()).toEqual([]);
  });

  it('does not leave usage or a file when the workspace or actor cannot be linked', async () => {
    await expect(reservations.reserveUpload({ ...input(), workspaceId: randomUUID() }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(reservations.reserveUpload({ ...input(), createdByUserId: randomUUID() }))
      .rejects.toMatchObject({ code: '23503' });
    expect(await rows()).toEqual([]);
    expect(await usage()).toEqual([]);
  });
});
