import { ARTIFACT_BUCKET, workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Public artifact downloads (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  const publicFile = randomUUID();
  const privateFile = randomUUID();
  const shared = randomUUID();
  const pending = randomUUID();
  const deleted = randomUUID();
  const contents = '<h1>public</h1>';
  const download = (id: string) => request(app.server).get(`/api/public/artifacts/${id}`);

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'public-file-owner');
    const workspaceId = owner.workspace.id;
    const file = (id: string) => ({
      id, workspaceId, createdByUserId: owner.user.userId, name: 'Public report.html',
      mimeType: 'text/html', sizeBytes: String(Buffer.byteLength(contents)),
      objectKey: workspaceArtifactKey(workspaceId, id), source: 'upload' as const,
      status: 'ready' as const, shareType: 'public' as const,
    });
    await app.dataSource.getRepository(WorkspaceArtifact).insert([
      file(publicFile),
      { ...file(privateFile), shareType: 'private' },
      { ...file(shared), shareType: 'shared' },
      { ...file(pending), status: 'pending', expiresAt: new Date(Date.now() + 3600000) },
      { ...file(deleted), status: 'deleted' },
    ]);
    await app.app.get(StorageService).uploadFile(
      workspaceArtifactKey(workspaceId, publicFile), Buffer.from(contents), ARTIFACT_BUCKET, 'text/html',
    );
  });

  afterAll(async () => {
    if (!app) return;
    try {
      if (owner) {
        await app.app.get(StorageService).deleteFile(workspaceArtifactKey(owner.workspace.id, publicFile), ARTIFACT_BUCKET);
      }
      await cleanupE2eData(app.dataSource, {
        workspaceIds: owner ? [owner.workspace.id] : [],
        userIds: owner ? [owner.user.userId] : [],
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('redirects an anonymous request to a non-cacheable five-minute attachment URL', async () => {
    const result = await download(publicFile).expect(302);
    expect(result.headers['cache-control']).toBe('private, no-store');
    const issuedUrl = result.headers.location;
    expect(new URL(issuedUrl).searchParams.get('X-Amz-Expires')).toBe('300');
    const file = await fetch(issuedUrl);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('content-disposition')).toContain('attachment; filename="Public report.html"');
    expect(await file.text()).toBe(contents);
  });

  it('returns 404 for unavailable files and validates IDs without authentication', async () => {
    for (const id of [privateFile, shared, pending, deleted, randomUUID()]) {
      const result = await download(id).expect(404);
      expect(result.headers.location).toBeUndefined();
    }
    await download('invalid').expect(400);
  });

  it('blocks new redirects after privacy changes while issued URLs retain their lifetime', async () => {
    const result = await download(publicFile).expect(302);
    const issuedUrl = result.headers.location;
    await request(app.server).patch(`/api/artifacts/${publicFile}`).set(owner.headers)
      .send({ shareType: 'private' }).expect(200);
    await download(publicFile).expect(404);
    const file = await fetch(issuedUrl);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(contents);
  });
});
