import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Artifact access-mode storage and metadata (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  const id = randomUUID();

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'file-access-mode');
    await app.dataSource.getRepository(WorkspaceArtifact).insert({
      id, workspaceId: owner.workspace.id, createdByUserId: owner.user.userId,
      name: 'file.txt', mimeType: 'text/plain', sizeBytes: '1',
      objectKey: workspaceArtifactKey(owner.workspace.id, id), source: 'upload', status: 'ready',
    });
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: owner ? [owner.workspace.id] : [],
        userIds: owner ? [owner.user.userId] : [],
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('defaults new files to private', async () => {
    const rows = await app.dataSource.query('SELECT "shareType" FROM artifacts WHERE id=$1', [id]);
    expect(rows).toEqual([{ shareType: 'private' }]);
  });

  it('stores the three recognized modes and rejects invalid values or null', async () => {
    for (const value of ['private', 'shared', 'public']) {
      await app.dataSource.query('UPDATE artifacts SET "shareType"=$1 WHERE id=$2', [value, id]);
      expect(await app.dataSource.query('SELECT "shareType" FROM artifacts WHERE id=$1', [id]))
        .toEqual([{ shareType: value }]);
    }
    await expect(app.dataSource.query('UPDATE artifacts SET "shareType"=$1 WHERE id=$2', ['unknown', id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(app.dataSource.query('UPDATE artifacts SET "shareType"=NULL WHERE id=$1', [id]))
      .rejects.toMatchObject({ code: '23502' });
  });

  it('reports each stored mode in existing file metadata and lists', async () => {
    for (const mode of ['private', 'shared', 'public']) {
      await app.dataSource.query('UPDATE artifacts SET "shareType"=$1 WHERE id=$2', [mode, id]);
      const detail = await request(app.server).get(`/api/artifacts/${id}`).set(owner.headers).expect(200);
      expect(detail.body.shareType).toBe(mode);
      const list = await request(app.server).get('/api/artifacts').set(owner.headers).expect(200);
      expect(list.body.data.find((file: { id: string }) => file.id === id).shareType).toBe(mode);
    }
  });

  it('keeps file downloads authenticated', async () => {
    await request(app.server).get(`/api/artifacts/${id}/download`).expect(401);
  });
});
