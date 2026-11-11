import { ARTIFACT_BUCKET, ARTIFACT_MAX_FILE_BYTES, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { ArtifactBufferService } from '@/modules/artifacts/artifact-buffer.service';
import { ArtifactCleanupService } from '@/modules/artifacts/artifact-cleanup.service';
import { ArtifactReadService } from '@/modules/artifacts/artifact-read.service';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from '@/modules/artifacts/entities/workspace-storage-usage.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private agent buffer writer (e2e)', () => {
  let app: TestApp;
  let writer: ArtifactBufferService;
  let storage: StorageService;
  let workspaceId: string;
  let userId: string;
  const repo = () => app.dataSource.getRepository(WorkspaceArtifact);
  const usage = () => app.dataSource.getRepository(WorkspaceStorageUsage).findOneBy({ workspaceId });
  const input = (buffer = Buffer.from('Résumé 🔒')) => ({ workspaceId, userId, name: '../report.txt', buffer, contentType: 'text/plain' });

  beforeAll(async () => {
    app = await createTestApp();
    writer = app.app.get(ArtifactBufferService);
    storage = app.app.get(StorageService);
  });
  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', ['Buffer ' + randomUUID()]);
    workspaceId = workspace.id;
    const [user] = await app.dataSource.query<{ id: string }[]>('INSERT INTO users (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id', ['Author', randomUUID() + '@example.test']);
    userId = user.id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const artifact of await repo().findBy({ workspaceId })) {
      await storage.deleteArtifactUploadObjects({ workspaceId, artifactId: artifact.id });
    }
    await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    await app.dataSource.query('DELETE FROM users WHERE id=$1', [userId]);
  });
  afterAll(async () => { if (app) await closeTestApp(app.app); });

  it.each([Buffer.from('Résumé 🔒'), Buffer.alloc(0)])('publishes exact bytes with private ownership and settled quota (%s)', async buffer => {
    const file = await writer.createAgentFile(input(buffer));
    expect(file).toMatchObject({ workspaceId, createdByUserId: userId, source: 'agent', status: 'ready', shareType: 'private', sizeBytes: String(buffer.length) });
    const saved = await repo().findOneByOrFail({ id: file.id });
    expect(saved.objectKey).toBe(`workspaces/${workspaceId}/${file.id}/file`);
    expect(await usage()).toMatchObject({ usedBytes: String(buffer.length), reservedBytes: '0' });
    const { url } = await app.app.get(ArtifactReadService).getDownloadUrl(workspaceId, userId, file.id);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(buffer);
    await storage.uploadFile(workspaceArtifactUploadKey(workspaceId, file.id), Buffer.from('changed'), ARTIFACT_BUCKET, 'text/plain');
    expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(buffer);
  });

  it.each([
    ['blank name', { name: '' }], ['invalid MIME', { contentType: 'invalid' }],
    ['oversized buffer', { buffer: Buffer.alloc(ARTIFACT_MAX_FILE_BYTES + 1) }],
    ['cancelled', { abortSignal: AbortSignal.abort(new Error('Stopped')) }],
  ] as const)('rejects %s before reserving', async (_label, invalid) => {
    await expect(writer.createAgentFile({ ...input(), ...invalid })).rejects.toThrow();
    expect(await repo().countBy({ workspaceId })).toBe(0);
    expect(await usage()).toBeNull();
  });

  it('rejects quota overflow without retaining a reservation', async () => {
    await app.dataSource.transaction(manager => app.app.get(ArtifactQuotaService).setQuota(manager, workspaceId, 0));
    await expect(writer.createAgentFile(input())).rejects.toMatchObject({ status: 409 });
    expect(await repo().countBy({ workspaceId })).toBe(0);
    expect(await usage()).toMatchObject({ usedBytes: '0', reservedBytes: '0' });
  });

  it.each(['write failure', 'cancel after copy'])('retains charged pending state for safe expiry after %s', async failure => {
    const controller = new AbortController();
    if (failure === 'write failure') jest.spyOn(storage, 'uploadFile').mockRejectedValueOnce(new Error('Fixture outage'));
    else {
      const publish = storage.publishArtifactUpload.bind(storage);
      jest.spyOn(storage, 'publishArtifactUpload').mockImplementationOnce(async options => {
        await publish(options);
        controller.abort(new Error('Stopped'));
      });
    }
    const data = input();
    await expect(writer.createAgentFile({ ...data, abortSignal: controller.signal })).rejects.toThrow();
    const file = await repo().findOneByOrFail({ workspaceId });
    expect(file).toMatchObject({ source: 'agent', status: 'pending' });
    expect(await usage()).toMatchObject({ usedBytes: '0', reservedBytes: String(data.buffer.length) });
    await repo().update(file.id, { expiresAt: new Date(Date.now() - 20 * 60_000) });
    await expect(app.app.get(ArtifactCleanupService).reclaim({ workspaceId, artifactId: file.id })).resolves.toBe(true);
    expect(await usage()).toMatchObject({ usedBytes: '0', reservedBytes: '0' });
    expect(await repo().countBy({ workspaceId })).toBe(0);
    await expect(storage.headObject(ARTIFACT_BUCKET, file.objectKey)).rejects.toMatchObject({ status: 404 });
  });
});
