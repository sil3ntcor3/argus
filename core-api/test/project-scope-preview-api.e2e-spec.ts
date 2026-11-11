import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project scope preview API (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let project: string, foreignProject: string, asset: string, role: string;
  const path = '/api/projects/scope-preview';
  const insert = async (sql: string, values: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(
        sql + ' RETURNING id',
        values,
      )
    )[0].id;
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'scope-preview-owner');
    reader = await createUserWithWorkspace(app.server, 'scope-preview-reader');
    project = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), owner.workspace.id],
    );
    foreignProject = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), reader.workspace.id],
    );
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['scope.argus.test', 'DOMAIN', owner.workspace.id],
    );
    asset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['host.argus.test', target],
    );
    await insert(
      'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',
      [project, asset],
    );
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      ['Scope reader', ['project.read'], owner.workspace.id],
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

  it('returns read-only counts with stable duplicate indices and a 200 response', async () => {
    const rule = { mode: 'include', type: 'asset', value: asset };
    const response = await request(app.server)
      .post(path)
      .set(owner.headers)
      .send({
        rules: [rule, { ...rule, value: asset.toUpperCase() }],
        projectId: project.toUpperCase(),
      })
      .expect(200);
    expect(response.body).toEqual({ ruleAssets: 1, total: 1, perRule: [1, 1] });
    const empty = await request(app.server)
      .post(path)
      .set(owner.headers)
      .send({ rules: [], projectId: project })
      .expect(200);
    expect(empty.body).toEqual({ ruleAssets: 0, total: 1, perRule: [] });
    expect(
      await app.dataSource.query(
        'SELECT id FROM project_scope_rules WHERE "projectId"=$1',
        [project],
      ),
    ).toEqual([]);
  });
  it('allows canonical and legacy read grants without granting project writes', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    for (const permission of ['project.read', 'group.read']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[permission], role],
      );
      await request(app.server)
        .post(path)
        .set(headers)
        .send({ rules: [], projectId: project })
        .expect(200);
      await request(app.server)
        .post('/api/projects')
        .set(headers)
        .send({ name: randomUUID() })
        .expect(403);
    }
  });
  it('preserves authentication, workspace and project boundaries', async () => {
    await request(app.server).post(path).send({ rules: [] }).expect(401);
    await request(app.server)
      .post(path)
      .set(owner.headers)
      .set('X-Workspace-Id', 'invalid')
      .send({ rules: [] })
      .expect(400);
    await request(app.server)
      .post(path)
      .set(owner.headers)
      .set('X-Workspace-Id', reader.workspace.id)
      .send({ rules: [] })
      .expect(403);
    for (const id of [foreignProject, randomUUID()])
      await request(app.server)
        .post(path)
        .set(owner.headers)
        .send({ rules: [], projectId: id })
        .expect(404);
  });
  it('rejects malformed nested rules and oversized input before preview', async () => {
    for (const body of [
      {},
      { rules: null },
      { rules: [{ mode: 'include', type: 'hostname', value: 123 }] },
      { rules: [{ mode: 'include', type: 'unknown', value: 'argus.test' }] },
      {
        rules: [{ mode: 'include', type: 'hostname', value: 'x'.repeat(256) }],
      },
      {
        rules: Array.from({ length: 101 }, () => ({
          mode: 'include',
          type: 'hostname',
          value: 'argus.test',
        })),
      },
      { rules: [], projectId: null },
      { rules: [{ mode: 'include', type: 'cidr', value: '192.0.2.0/99' }] },
    ]) {
      await request(app.server)
        .post(path)
        .set(owner.headers)
        .send(body)
        .expect(400);
    }
  });
  it('documents the nested body, response and actual success status', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder().build(),
    );
    const operation = doc.paths[path].post!;
    expect(operation.operationId).toBe('ProjectsController_previewScope');
    expect(operation.responses['200']).toBeDefined();
    expect(operation.responses['201']).toBeUndefined();
    expect(operation.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ScopePreviewDto' },
        },
      },
    });
  });
});
