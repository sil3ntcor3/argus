import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project scope-rule read API (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let project: string,
    empty: string,
    foreign: string,
    rule: string,
    role: string;
  const path = (id: string) => '/api/projects/' + id + '/scope-rules';
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'scope-read-owner');
    reader = await createUserWithWorkspace(app.server, 'scope-read-reader');
    project = await insert(
      'INSERT INTO projects (name,"workspaceId","autoAddAssets") VALUES ($1,$2,false)',
      [randomUUID(), owner.workspace.id],
    );
    empty = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), owner.workspace.id],
    );
    foreign = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), reader.workspace.id],
    );
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['scope.argus.test', 'DOMAIN', owner.workspace.id],
    );
    const asset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['host.argus.test', target],
    );
    await insert(
      'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',
      [project, asset],
    );
    rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'hostname', '*.argus.test'],
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
  it('returns only documented saved rules, preference and membership counts', async () => {
    const before = await app.dataSource.query(
      'SELECT * FROM project_scope_rules WHERE id=$1',
      [rule],
    );
    for (const id of [project, project.toUpperCase()]) {
      const response = await request(app.server)
        .get(path(id))
        .set(owner.headers)
        .expect(200);
      expect(response.body).toEqual({
        autoAddAssets: false,
        ruleAssets: 0,
        manualAssets: 1,
        rules: [
          {
            id: rule,
            mode: 'include',
            type: 'hostname',
            value: '*.argus.test',
            label: '*.argus.test',
            matched: 1,
          },
        ],
      });
    }
    expect(
      await app.dataSource.query(
        'SELECT * FROM project_scope_rules WHERE id=$1',
        [rule],
      ),
    ).toEqual(before);
  });
  it('allows canonical and legacy read grants while preserving write denial', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    for (const permission of ['project.read', 'group.read']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[permission], role],
      );
      await request(app.server).get(path(project)).set(headers).expect(200);
      await request(app.server)
        .patch('/api/projects/' + project)
        .set(headers)
        .send({ name: 'Denied' })
        .expect(403);
    }
  });
  it('preserves authentication, workspace and project boundaries', async () => {
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [[], role],
    );
    await request(app.server)
      .get(path(project))
      .set({ ...reader.headers, 'X-Workspace-Id': owner.workspace.id })
      .expect(403);
    await request(app.server).get(path(project)).expect(401);
    await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .set('X-Workspace-Id', reader.workspace.id)
      .expect(403);
    await request(app.server)
      .get(path(project))
      .set(reader.headers)
      .expect(404);
    for (const id of [foreign, randomUUID()])
      await request(app.server).get(path(id)).set(owner.headers).expect(404);
    await request(app.server)
      .get(path('invalid'))
      .set(owner.headers)
      .expect(400);
  });
  it('returns the saved default for empty projects', async () => {
    const response = await request(app.server)
      .get(path(empty))
      .set(owner.headers)
      .expect(200);
    expect(response.body).toEqual({
      rules: [],
      autoAddAssets: true,
      ruleAssets: 0,
      manualAssets: 0,
    });
  });
  it('replaces scope atomically and returns numeric counts while retaining manual membership and an omitted preference', async () => {
    const created = await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({ name: randomUUID() })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const [target] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM targets WHERE "workspaceId"=$1 LIMIT 1',
      [owner.workspace.id],
    );
    const assets = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2),($3,$2) RETURNING id',
      [
        randomUUID() + '.scopewrite.test',
        target.id,
        randomUUID() + '.scopewrite.test',
      ],
    );
    await request(app.server)
      .post('/api/asset-group/' + id + '/assets')
      .set(owner.headers)
      .send({ assetIds: [assets[0].id] })
      .expect(201);
    const updated = await request(app.server)
      .put(path(id.toUpperCase()))
      .set(owner.headers)
      .send({
        rules: [
          {
            mode: 'include',
            type: 'asset',
            value: ' ' + assets[1].id.toUpperCase() + ' ',
          },
        ],
        autoAddAssets: false,
      })
      .expect(200);
    expect(updated.body).toEqual({ added: 1, removed: 0 });
    expect(
      (await request(app.server).get(path(id)).set(owner.headers).expect(200))
        .body,
    ).toMatchObject({ autoAddAssets: false, manualAssets: 1, ruleAssets: 1 });
    expect(
      (
        await request(app.server)
          .put(path(id))
          .set(owner.headers)
          .send({ rules: [] })
          .expect(200)
      ).body,
    ).toEqual({ added: 0, removed: 1 });
    expect(
      (await request(app.server).get(path(id)).set(owner.headers).expect(200))
        .body,
    ).toEqual({
      rules: [],
      autoAddAssets: false,
      manualAssets: 1,
      ruleAssets: 0,
    });
  });
  it('requires canonical or legacy write grants and retains authentication and tenant boundaries', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    const body = { rules: [], autoAddAssets: true };
    for (const permission of [
      'project.write',
      'group.write',
      'project.read',
      'group.read',
    ]) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[permission], role],
      );
      const result = await request(app.server)
        .put(path(empty))
        .set(headers)
        .send(body)
        .expect(permission.endsWith('.write') ? 200 : 403);
      if (permission.endsWith('.write'))
        expect(result.body).toEqual({ added: 0, removed: 0 });
    }
    await request(app.server).put(path(empty)).send(body).expect(401);
    await request(app.server)
      .put(path(empty))
      .set(owner.headers)
      .set('X-Workspace-Id', reader.workspace.id)
      .send(body)
      .expect(403);
    await request(app.server)
      .put(path(empty))
      .set(reader.headers)
      .send(body)
      .expect(404);
    for (const id of [foreign, randomUUID()])
      await request(app.server)
        .put(path(id))
        .set(owner.headers)
        .send(body)
        .expect(404);
    await request(app.server)
      .put(path('invalid'))
      .set(owner.headers)
      .send(body)
      .expect(400);
  });
  it('rejects malformed, oversized and foreign-reference writes without changing saved scope', async () => {
    const [foreignAsset] = await app.dataSource.query<{ id: string }[]>(
      `WITH t AS (INSERT INTO targets (value,type,"workspaceId") VALUES ($1,'DOMAIN',$2) RETURNING id)
      INSERT INTO assets (value,"targetId") SELECT $1,id FROM t RETURNING id`,
      [randomUUID() + '.foreign.scopewrite.test', reader.workspace.id],
    );
    const before = (
      await request(app.server).get(path(empty)).set(owner.headers).expect(200)
    ).body as object;
    for (const body of [
      {},
      { rules: null },
      { rules: [null] },
      {
        rules: Array.from({ length: 101 }, () => ({
          mode: 'include',
          type: 'asset',
          value: randomUUID(),
        })),
      },
      { rules: [], autoAddAssets: null },
      { rules: [], autoAddAssets: 'false' },
      { rules: [{ mode: 'include', type: 'asset', value: foreignAsset.id }] },
      { rules: [{ mode: 'include', type: 'asset', value: randomUUID() }] },
      { rules: [{ mode: 'include', type: 'hostname', value: '*' }] },
    ])
      await request(app.server)
        .put(path(empty))
        .set(owner.headers)
        .send(body)
        .expect(400);
    expect(
      (
        await request(app.server)
          .get(path(empty))
          .set(owner.headers)
          .expect(200)
      ).body,
    ).toEqual(before);
  });
  it('documents the nested rule response and existing enum components', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder().build(),
    );
    const operation = doc.paths['/api/projects/{id}/scope-rules'].get!;
    const write = doc.paths['/api/projects/{id}/scope-rules'].put!;
    expect(write.operationId).toBe('ProjectsController_replaceScopeRules');
    expect(write.responses['200']).toBeDefined();
    const input = doc.components!.schemas!.ReplaceScopeRulesDto as {
      required: string[];
      properties: Record<string, object>;
    };
    expect(input.required).toEqual(['rules']);
    expect(input.properties.rules).toMatchObject({
      type: 'array',
      maxItems: 100,
    });
    expect(input.properties.autoAddAssets).toEqual({ type: 'boolean' });
    const numeric = doc.components!.schemas!.ScopeSyncResultDto as {
      properties: Record<string, object>;
    };
    expect(numeric.properties).toEqual({
      added: { type: 'integer', minimum: 0 },
      removed: { type: 'integer', minimum: 0 },
    });
    expect(operation.operationId).toBe('ProjectsController_getScopeRules');
    expect(operation.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ProjectScopeDto' },
        },
      },
    });
    expect(doc.components?.schemas?.ScopeRuleDto).toMatchObject({
      properties: {
        mode: {
          allOf: [{ $ref: '#/components/schemas/ProjectScopeRuleMode' }],
        },
        type: {
          allOf: [{ $ref: '#/components/schemas/ProjectScopeRuleType' }],
        },
        matched: { type: 'integer', minimum: 0 },
      },
    });
  });
});
