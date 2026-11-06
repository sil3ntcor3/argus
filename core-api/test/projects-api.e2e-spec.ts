import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical Projects CRUD (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let projectId: string;
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'projects-api-owner');
    other = await createUserWithWorkspace(app.server, 'projects-api-other');
    const [row]: { id: string }[] = await app.dataSource.query(
      'INSERT INTO projects (name, "workspaceId") VALUES ($1, $2) RETURNING id',
      ['Argus protected project', owner.workspace.id],
    );
    projectId = row.id;
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('shares create, filtered list, read, update and delete with legacy Groups', async () => {
    const name = 'Argus project ' + randomUUID();
    const created = await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({ name, hexColor: '#123456' })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const list = await request(app.server)
      .get('/api/projects')
      .query({ search: name, limit: 1, page: 1 })
      .set(owner.headers)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id, name, hexColor: '#123456' });
    await request(app.server)
      .get(`/api/asset-group/${id}`)
      .set(owner.headers)
      .expect(200);
    await request(app.server)
      .patch(`/api/projects/${id}`)
      .set(owner.headers)
      .send({ name: name + ' canonical' })
      .expect(200);
    const legacy = await request(app.server)
      .get(`/api/asset-group/${id}`)
      .set(owner.headers)
      .expect(200);
    expect(legacy.body.name).toBe(name + ' canonical');
    await request(app.server)
      .patch(`/api/asset-group/${id}`)
      .set(owner.headers)
      .send({ name: name + ' legacy' })
      .expect(200);
    const canonical = await request(app.server)
      .get(`/api/projects/${id}`)
      .set(owner.headers)
      .expect(200);
    expect(canonical.body.name).toBe(name + ' legacy');
    await request(app.server)
      .delete(`/api/projects/${id}`)
      .set(owner.headers)
      .expect(200);
    await request(app.server)
      .get(`/api/asset-group/${id}`)
      .set(owner.headers)
      .expect(404);
  });

  it('keeps authentication and workspace boundaries on every operation', async () => {
    const http = request(app.server);
    for (const method of ['get', 'patch', 'delete'] as const) {
      await http[method](`/api/projects/${projectId}`)
        .send({ name: 'Denied' })
        .expect(401);
      await http[method](`/api/projects/${projectId}`)
        .set(other.headers)
        .send({ name: 'Denied' })
        .expect(404);
      await http[method](`/api/projects/${projectId}`)
        .set(owner.headers)
        .set('X-Workspace-Id', other.workspace.id)
        .send({ name: 'Denied' })
        .expect(403);
    }
    await request(app.server)
      .post('/api/projects')
      .send({ name: 'Denied' })
      .expect(401);
    await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .set('X-Workspace-Id', other.workspace.id)
      .send({ name: 'Denied' })
      .expect(403);
    const list = await request(app.server)
      .get('/api/projects')
      .set(other.headers)
      .expect(200);
    expect(list.body.data).toEqual([]);
    const unchanged = await request(app.server)
      .get(`/api/projects/${projectId}`)
      .set(owner.headers)
      .expect(200);
    expect(unchanged.body.name).toBe('Argus protected project');
  });

  it('validates identifiers, creation input and list parameters before persistence', async () => {
    const http = request(app.server);
    for (const method of ['get', 'patch', 'delete'] as const)
      await http[method]('/api/projects/not-a-uuid')
        .set(owner.headers)
        .send({ name: 'Invalid' })
        .expect(400);
    await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({})
      .expect(400);
    await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({ name: 'Invalid', hexColor: 'not-a-color' })
      .expect(400);
    await request(app.server)
      .get('/api/projects')
      .query({ page: 0 })
      .set(owner.headers)
      .expect(400);
  });

  it('documents distinct canonical operations while retaining legacy identifiers', () => {
    const document = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder().build(),
    );
    const paths = document.paths;
    expect(paths['/api/projects']?.get?.operationId).toBe(
      'ProjectsController_getMany',
    );
    expect(paths['/api/projects']?.post?.operationId).toBe(
      'ProjectsController_create',
    );
    expect(paths['/api/projects']?.post?.responses?.['201']).toBeDefined();
    for (const [method, name] of [
      ['get', 'getById'],
      ['patch', 'update'],
      ['delete', 'delete'],
    ] as const)
      expect(paths['/api/projects/{id}']?.[method]?.operationId).toBe(
        'ProjectsController_' + name,
      );
    expect(paths['/api/asset-group']?.get?.operationId).toBe(
      'AssetGroupController_getAll',
    );
    const ids: string[] = [];
    for (const path of Object.values(paths as Record<string, unknown>)) {
      if (!path || typeof path !== 'object') continue;
      for (const operation of Object.values(path as Record<string, unknown>)) {
        if (
          operation &&
          typeof operation === 'object' &&
          'operationId' in operation &&
          typeof operation.operationId === 'string' &&
          operation.operationId.startsWith('ProjectsController_')
        )
          ids.push(operation.operationId);
      }
    }
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
});
