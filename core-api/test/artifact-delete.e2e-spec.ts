import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { ArtifactExpirySweepService, ARTIFACT_EXPIRY_CURSOR } from '@/modules/artifacts/artifact-expiry-sweep.service';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactUploadCompletionService } from '@/modules/artifacts/artifact-upload-completion.service';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { RedisService } from '@/services/redis/redis.service';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Workspace file deletion (e2e)', () => {
  let app: TestApp;
  let storage: StorageService;
  let manager: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let creator: typeof manager;
  let workspaceId: string;
  let groupId: string;
  const fixtures: WorkspaceArtifact[] = [];
  const creatorHeaders = () => wsHeaders(creator.user.cookie, workspaceId);
  const remove = (id: string, headers: Record<string, string>) =>
    request(app.server).delete(`/api/artifacts/${encodeURIComponent(id)}`).set(headers);
  const get = (path: string, headers = manager.headers) => request(app.server).get(`/api/artifacts/${path}`).set(headers);
  const permissions = (keys: string[]) => app.dataSource.query(
    'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [keys, groupId],
  );
  const record = (id: string) => app.dataSource.getRepository(WorkspaceArtifact).findOneBy({ id });
  const usage = async () => (await get('usage').expect(200)).body as { usedBytes: number; reservedBytes: number };
  const stageKey = (file: WorkspaceArtifact) => workspaceArtifactUploadKey(file.workspaceId, file.id);

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    storage = app.app.get(StorageService);
    manager = await createUserWithWorkspace(app.server, 'delete-manager');
    creator = await createUserWithWorkspace(app.server, 'delete-creator');
    workspaceId = manager.workspace.id;
    const [{ id: member }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2) RETURNING id', [workspaceId, creator.user.userId],
    );
    [{ id: groupId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3) RETURNING id',
      ['File deletion fixture', ['artifact.read'], workspaceId],
    );
    await app.dataSource.query('INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)', [member, groupId]);
  });

  afterAll(async () => {
    if (!app) return;
    try {
      for (const file of fixtures) await storage.deleteArtifactUploadObjects({ workspaceId: file.workspaceId, artifactId: file.id });
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [manager?.workspace.id, creator?.workspace.id].filter(Boolean),
        userIds: [manager?.user.userId, creator?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  async function createFile(actor = creator, ready = true) {
    const quota = app.app.get(ArtifactQuotaService);
    const reservation = new ArtifactUploadReservationService(app.dataSource, storage, quota);
    const completion = new ArtifactUploadCompletionService(app.dataSource, storage, quota);
    const { artifact } = await reservation.reserveUpload({
      workspaceId, createdByUserId: actor.user.userId, name: 'delete-fixture.txt', contentType: 'text/plain', sizeBytes: 3,
    });
    fixtures.push(artifact);
    await storage.uploadFile(stageKey(artifact), Buffer.from('one'), ARTIFACT_BUCKET, 'text/plain');
    return ready ? completion.completeUpload({ workspaceId, userId: actor.user.userId, artifactId: artifact.id }) : artifact;
  }

  it('enforces workspace permissions and deletes only a ready owned file for a writer', async () => {
    const file = await createFile();
    const sibling = await createFile(manager);
    const pending = await createFile(creator, false);
    const before = await usage();
    await remove(file.id, {}).expect(401);
    await remove(file.id, creator.headers).expect(404);
    await remove(file.id, wsHeaders(creator.user.cookie, randomUUID())).expect(403);
    await remove('bad-id', creatorHeaders()).expect(400);
    await remove(file.id, creatorHeaders()).expect(403);
    await permissions(['artifact.manage']);
    await remove(file.id, creatorHeaders()).expect(403);
    await permissions(['artifact.write']);
    await remove(sibling.id, creatorHeaders()).expect(404);
    await remove(pending.id, creatorHeaders()).expect(404);
    expect(await usage()).toMatchObject({ usedBytes: before.usedBytes, reservedBytes: before.reservedBytes });
    const signed = (await get(`${file.id}/download`, creatorHeaders()).expect(200)).body as { url: string };
    const outcomes = await Promise.all([remove(file.id, creatorHeaders()), remove(file.id, creatorHeaders())]);
    expect(outcomes.map(result => result.status).sort()).toEqual([200, 404]);
    expect(outcomes.find(result => result.status === 200)?.body).toEqual({ message: 'File deleted' });
    await get(file.id).expect(404);
    await get(`${file.id}/download`, creatorHeaders()).expect(404);
    const revoked = await fetch(signed.url);
    expect(revoked.status).toBe(404);
    await revoked.body?.cancel();
    expect(await record(file.id)).toBeNull();
    expect(await record(sibling.id)).toMatchObject({ status: 'ready' });
    expect(await record(pending.id)).toMatchObject({ status: 'pending' });
    await expect(storage.headObject(ARTIFACT_BUCKET, stageKey(file))).rejects.toMatchObject({ status: 404 });
    expect(await usage()).toMatchObject({ usedBytes: before.usedBytes - 3, reservedBytes: before.reservedBytes });
  });

  it('allows a manager to hide another creator’s file and retries object deletion before releasing its quota', async () => {
    const file = await createFile(manager);
    await permissions(['artifact.read', 'artifact.manage']);
    const before = await usage();
    const outage = jest.spyOn(storage, 'deleteArtifactUploadObjects').mockRejectedValueOnce(new Error('fixture storage outage'));
    try {
      await remove(file.id, creatorHeaders()).expect(200, { message: 'File deleted' });
      expect(outage).toHaveBeenCalledWith({ workspaceId, artifactId: file.id });
    } finally {
      outage.mockRestore();
    }
    expect(await record(file.id)).toMatchObject({ status: 'deleted' });
    await get(file.id).expect(404);
    await get(`${file.id}/download`).expect(404);
    expect(await usage()).toMatchObject({ usedBytes: before.usedBytes, reservedBytes: before.reservedBytes });

    const redis = app.app.get(RedisService);
    const cursorKey = `${ARTIFACT_EXPIRY_CURSOR}:test:${workspaceId}`;
    const mapKey = (key: string) => key === ARTIFACT_EXPIRY_CURSOR ? cursorKey : key;
    const cursor = jest.spyOn(redis, 'get').mockImplementation(key => redis.cacheClient.get(mapKey(key)));
    const save = jest.spyOn(redis, 'set').mockImplementation((key, value) => redis.cacheClient.set(mapKey(key), String(value)));
    const clear = jest.spyOn(redis, 'del').mockImplementation(key => redis.client.del(mapKey(key)));
    const release = jest.spyOn(app.app.get(ArtifactQuotaService), 'releaseUsed').mockResolvedValueOnce(false);
    try {
      const sweep = app.app.get(ArtifactExpirySweepService);
      await sweep.sweepPage();
      expect(await record(file.id)).toMatchObject({ status: 'deleted' });
      expect(await usage()).toMatchObject({ usedBytes: before.usedBytes, reservedBytes: before.reservedBytes });
      await expect(storage.headObject(ARTIFACT_BUCKET, file.objectKey)).rejects.toMatchObject({ status: 404 });
      await sweep.sweepPage();
    } finally {
      release.mockRestore();
      cursor.mockRestore();
      save.mockRestore();
      clear.mockRestore();
      await redis.del(cursorKey);
    }
    expect(await record(file.id)).toBeNull();
    await expect(storage.headObject(ARTIFACT_BUCKET, file.objectKey)).rejects.toMatchObject({ status: 404 });
    expect(await usage()).toMatchObject({ usedBytes: before.usedBytes - 3, reservedBytes: before.reservedBytes });
  });
});
