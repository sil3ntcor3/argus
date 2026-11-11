import { ARTIFACT_BUCKET, workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { ArtifactReadService } from '@/modules/artifacts/artifact-read.service';
import { ArtifactShare } from '@/modules/artifacts/entities/artifact-share.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Named recipient file access (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let recipient: typeof owner;
  let memberId: string;
  let groupId: string;
  const shared = randomUUID();
  const privateFile = randomUUID();
  const publicFile = randomUUID();
  const pending = randomUUID();
  const deleted = randomUUID();
  const unshared = randomUUID();
  const foreign = randomUUID();
  const orphan = randomUUID();
  const mine = randomUUID();
  const headers = () => wsHeaders(recipient.user.cookie, owner.workspace.id);
  const detail = (id: string) => request(app.server).get(`/api/artifacts/${id}`).set(headers());
  const download = (id: string) => request(app.server).get(`/api/artifacts/${id}/download`).set(headers());
  const permissions = (keys: string[]) => app.dataSource.query(
    'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [keys, groupId],
  );

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'shared-file-owner');
    recipient = await createUserWithWorkspace(app.server, 'shared-file-reader');
    const workspaceId = owner.workspace.id;
    [{ id: memberId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2) RETURNING id',
      [workspaceId, recipient.user.userId],
    );
    [{ id: groupId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions ("workspaceId",name,permissions) VALUES ($1,$2,$3) RETURNING id',
      [workspaceId, 'Shared file reader', ['artifact.read']],
    );
    await app.dataSource.query('INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)', [memberId, groupId]);
    const file = (id: string) => ({
      id, workspaceId, createdByUserId: owner.user.userId, name: 'shared.txt', mimeType: 'text/plain',
      objectKey: workspaceArtifactKey(workspaceId, id), source: 'upload' as const, status: 'ready' as const,
      shareType: 'shared' as const, sizeBytes: '6', createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await app.dataSource.getRepository(WorkspaceArtifact).insert([
      file(shared), file(unshared),
      { ...file(orphan), createdByUserId: null, name: 'Legacy report.txt' },
      { ...file(mine), createdByUserId: recipient.user.userId },
      { ...file(privateFile), shareType: 'private' },
      { ...file(publicFile), shareType: 'public' },
      { ...file(pending), status: 'pending', expiresAt: new Date(Date.now() + 3600000) },
      { ...file(deleted), status: 'deleted' },
      { ...file(foreign), workspaceId: recipient.workspace.id, objectKey: workspaceArtifactKey(recipient.workspace.id, foreign) },
    ]);
    await app.dataSource.getRepository(ArtifactShare).insert(
      [shared, privateFile, publicFile, pending, deleted, foreign, orphan, mine].map(artifactId => ({ artifactId, userId: recipient.user.userId })),
    );
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, recipient?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, recipient?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('returns metadata and a five-minute attachment download for a named current member', async () => {
    const result = await detail(shared).expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toMatchObject({ id: shared, shareType: 'shared', isOwner: false });
    const key = workspaceArtifactKey(owner.workspace.id, shared);
    const storage = app.app.get(StorageService);
    await storage.uploadFile(key, Buffer.from('shared'), ARTIFACT_BUCKET, 'text/plain');
    try {
      const link = await download(shared).expect(200);
      expect(link.headers['cache-control']).toBe('private, no-store');
      expect(link.body).toEqual({ url: expect.any(String), expiresIn: 300 });
      const file = await fetch((link.body as { url: string }).url);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('application/octet-stream');
      expect(file.headers.get('content-disposition')).toContain('attachment;');
      expect(await file.text()).toBe('shared');
    } finally {
      await storage.deleteFile(key, ARTIFACT_BUCKET);
    }
  });

  it('hides other modes, unlisted, pending, deleted, and other-workspace files', async () => {
    for (const id of [privateFile, publicFile, pending, deleted, unshared, foreign]) {
      await detail(id).expect(404);
      await download(id).expect(404);
    }
    await request(app.server).get(`/api/artifacts/${shared}/download`).expect(401);
  });

  it('paginates named shared files with stable ties and includes removed creators', async () => {
    const ids = [shared, orphan].sort();
    const list = (query: object) => request(app.server).get('/api/artifacts').set(headers())
      .query({ scope: 'shared', limit: 1, sortBy: 'createdAt', sortOrder: 'ASC', ...query });
    const first = await list({}).expect(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.body).toMatchObject({ total: 2, page: 1, hasNextPage: true, data: [{ id: ids[0], isOwner: false, shareType: 'shared' }] });
    const second = await list({ page: 2 }).expect(200);
    expect(second.body).toMatchObject({ total: 2, page: 2, hasNextPage: false, data: [{ id: ids[1] }] });
    const legacy = await list({ search: 'Legacy' }).expect(200);
    expect(legacy.body).toMatchObject({ total: 1, data: [{ id: orphan, createdBy: null }] });
    const mineResult = await request(app.server).get('/api/artifacts').set(headers()).query({ scope: 'mine' }).expect(200);
    expect(mineResult.body.data.map((file: { id: string }) => file.id)).toEqual([mine]);
    for (const parentFolderId of ['root', randomUUID()]) {
      await list({ parentFolderId }).expect(400);
    }
  });

  it('requires effective file read access while keeping management metadata-only', async () => {
    await permissions([]);
    await detail(shared).expect(403);
    await download(shared).expect(403);
    await request(app.server).get('/api/artifacts').set(headers()).query({ scope: 'shared' }).expect(403);
    await permissions(['artifact.read', 'artifact.manage']);
    await detail(privateFile).expect(200);
    await download(privateFile).expect(404);
    await permissions(['artifact.read']);
  });

  it('denies new access after revocation or switching to private', async () => {
    await request(app.server).delete(`/api/artifacts/${shared}/shares/${recipient.user.userId}`).set(owner.headers).expect(200);
    await detail(shared).expect(404);
    await download(shared).expect(404);
    const revoked = await request(app.server).get('/api/artifacts').set(headers()).query({ scope: 'shared' }).expect(200);
    expect(revoked.body.data.map((file: { id: string }) => file.id)).toEqual([orphan]);
    await request(app.server).post(`/api/artifacts/${shared}/shares`).set(owner.headers)
      .send({ emails: [recipient.user.email] }).expect(201);
    await detail(shared).expect(200);
    await request(app.server).patch(`/api/artifacts/${shared}`).set(owner.headers).send({ shareType: 'private' }).expect(200);
    await detail(shared).expect(404);
    await download(shared).expect(404);
    await request(app.server).patch(`/api/artifacts/${shared}`).set(owner.headers).send({ shareType: 'shared' }).expect(200);
  });

  it('denies former members even when a recipient record remains', async () => {
    await app.dataSource.query('DELETE FROM workspace_members WHERE id=$1', [memberId]);
    await detail(shared).expect(403);
    await download(shared).expect(403);
    const files = app.app.get(ArtifactReadService);
    await expect(files.getById(owner.workspace.id, recipient.user.userId, shared, [])).rejects.toMatchObject({ status: 404 });
    await expect(files.getDownloadUrl(owner.workspace.id, recipient.user.userId, shared)).rejects.toMatchObject({ status: 404 });
  });
});
