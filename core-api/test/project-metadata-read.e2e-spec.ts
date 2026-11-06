import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project metadata reads (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let reader: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let id: string, name: string;
  const description = 'Argus project context ✓';
  const insert = async (sql: string, values: unknown[]): Promise<string> =>
    (
      await app.dataSource.query<{ id: string }[]>(
        sql + ' RETURNING id',
        values,
      )
    )[0].id;
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'metadata-read-owner');
    reader = await createUserWithWorkspace(app.server, 'metadata-reader');
    name = 'Argus metadata ' + randomUUID();
    id = await insert(
      'INSERT INTO projects (name, description, "autoAddAssets", "archivedAt", "workspaceId") VALUES ($1,$2,false,$3,$4)',
      [name, description, '2026-11-06T00:00:00.000Z', owner.workspace.id],
    );
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    const role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      ['Project reader', ['project.read'], owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('exposes saved description and automatic-membership preference only on canonical reads', async () => {
    for (const path of [
      `/api/projects/${id}`,
      `/api/projects/${id.toUpperCase()}`,
      '/api/projects?search=' + encodeURIComponent(name),
    ]) {
      const response = await request(app.server)
        .get(path)
        .set(owner.headers)
        .expect(200);
      const value = path.includes('?') ? response.body.data[0] : response.body;
      expect(value).toMatchObject({
        id,
        name,
        description,
        autoAddAssets: false,
        totalAssets: 0,
      });
      expect(value).not.toHaveProperty('archivedAt');
    }
    for (const path of [
      `/api/asset-group/${id}`,
      '/api/asset-group?search=' + encodeURIComponent(name),
    ]) {
      const response = await request(app.server)
        .get(path)
        .set(owner.headers)
        .expect(200);
      const value = path.includes('?') ? response.body.data[0] : response.body;
      for (const key of ['description', 'autoAddAssets', 'archivedAt'])
        expect(value).not.toHaveProperty(key);
    }
  });

  it('uses existing read grants and preserves authentication, workspace and write boundaries', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    const allowed = await request(app.server)
      .get(`/api/projects/${id}`)
      .set(headers)
      .expect(200);
    expect(allowed.body.description).toBe(description);
    await request(app.server)
      .patch(`/api/projects/${id}`)
      .set(headers)
      .send({ name: 'Denied' })
      .expect(403);
    await request(app.server).get(`/api/projects/${id}`).expect(401);
    await request(app.server)
      .get(`/api/projects/${id}`)
      .set(reader.headers)
      .expect(404);
    await request(app.server)
      .get('/api/projects')
      .set(owner.headers)
      .set('X-Workspace-Id', reader.workspace.id)
      .expect(403);
    const empty = await request(app.server)
      .get('/api/projects?search=' + randomUUID())
      .set(owner.headers)
      .expect(200);
    expect(empty.body.data).toEqual([]);
  });

  it('retains default metadata when canonical mutations omit it', async () => {
    const created = await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({
        name: randomUUID(),
      })
      .expect(201);
    const createdId = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({
      description: null,
      autoAddAssets: true,
    });
    expect(created.body).not.toHaveProperty('archivedAt');
    const changed = await request(app.server)
      .patch(`/api/projects/${createdId}`)
      .set(owner.headers)
      .send({
        name: randomUUID(),
      })
      .expect(200);
    expect(changed.body).toMatchObject({
      description: null,
      autoAddAssets: true,
    });
    expect(changed.body).not.toHaveProperty('archivedAt');
    const view = await request(app.server)
      .get(`/api/projects/${createdId}`)
      .set(owner.headers)
      .expect(200);
    expect(view.body).toMatchObject({ description: null, autoAddAssets: true });
  });
});
