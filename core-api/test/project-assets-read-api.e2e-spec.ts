import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project member list API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let project: string,
    foreign: string,
    target: string,
    rule: string,
    run: string,
    role: string;
  const assets: string[] = [];
  const path = (id: string) => '/api/projects/' + id + '/assets';
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'member-api-owner');
    reader = await createUserWithWorkspace(app.server, 'member-api-reader');
    project = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), owner.workspace.id],
    );
    foreign = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), reader.workspace.id],
    );
    target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['member-api.argus.test', 'DOMAIN', owner.workspace.id],
    );
    for (const name of ['alpha', 'beta'])
      assets.push(
        await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
          name + '.member-api.argus.test',
          target,
        ]),
      );
    rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'asset', assets[1].toUpperCase()],
    );
    for (const [i, id] of assets.entries())
      await app.dataSource.query(
        'INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId") VALUES ($1,$2,$3,$4)',
        [project, id, i ? 'rule' : 'manual', i ? rule : null],
      );
    const workflow = await insert(
      'INSERT INTO workflows (name,content,"filePath","workspaceId") VALUES ($1,$2,$3,$4)',
      [
        randomUUID(),
        JSON.stringify({ name: 'Argus member API', jobs: {} }),
        randomUUID() + '.yaml',
        owner.workspace.id,
      ],
    );
    run = await insert(
      'INSERT INTO job_histories ("workflowId","projectId",scope) VALUES ($1,$2,$3)',
      [workflow, project, JSON.stringify({ assetIds: [assets[1]] })],
    );
    const finding = await insert(
      'INSERT INTO vulnerabilities (name,severity,"assetId") VALUES ($1,$2,$3)',
      [randomUUID(), 'high', assets[1]],
    );
    await app.dataSource.query(
      'INSERT INTO project_vulnerabilities ("projectId","vulnerabilityId") VALUES ($1,$2)',
      [project, finding],
    );
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      [randomUUID(), ['project.read'], owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
  });
  beforeEach(async () => {
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [['project.read'], role],
    );
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  it('serializes the enriched member contract, numeric paging/counts and nullable provenance', async () => {
    const query = { sortBy: 'value', sortOrder: 'ASC', limit: 1 };
    const first = await request(app.server)
      .get(path(project.toUpperCase()))
      .set(owner.headers)
      .query(query)
      .expect(200);
    expect(first.body).toMatchObject({
      total: 2,
      page: 1,
      limit: 1,
      pageCount: 2,
      hasNextPage: true,
    });
    expect(first.body.data[0]).toMatchObject({
      id: assets[0],
      source: 'manual',
      rule: null,
      lastScan: null,
      targetId: target,
      targetType: 'DOMAIN',
      targetValue: 'member-api.argus.test',
      vulnerabilities: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    });
    const second = await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .query({ ...query, page: 2 })
      .expect(200);
    expect(second.body.hasNextPage).toBe(false);
    expect(second.body.data[0]).toMatchObject({
      id: assets[1],
      source: 'rule',
      rule: {
        id: rule,
        type: 'asset',
        value: assets[1].toUpperCase(),
        label: 'beta.member-api.argus.test',
      },
      lastScan: { runId: run, createdAt: expect.any(String) },
      addedAt: expect.any(String),
      vulnerabilities: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    });
    expect(Object.keys(second.body.data[0]).sort()).toEqual(
      [
        'id',
        'value',
        'targetId',
        'targetValue',
        'targetType',
        'source',
        'rule',
        'addedAt',
        'vulnerabilities',
        'lastScan',
      ].sort(),
    );
  });
  it('filters source/search and validates enums, safe integer paging, route IDs and sort input', async () => {
    for (const [source, index] of [
      ['manual', 0],
      ['rule', 1],
    ] as const) {
      const r = await request(app.server)
        .get(path(project))
        .set(owner.headers)
        .query({ source, search: index ? 'BETA' : 'ALPHA' })
        .expect(200);
      expect(r.body.total).toBe(1);
      expect(r.body.data[0].id).toBe(assets[index]);
    }
    for (const query of [
      { source: 'invalid' },
      { page: 0 },
      { page: 1.5 },
      { limit: 0 },
      { limit: 1.5 },
      { limit: 101 },
      { sortOrder: 'invalid' },
      { sortBy: 'value DESC--' },
    ])
      await request(app.server)
        .get(path(project))
        .set(owner.headers)
        .query(query)
        .expect(400);
    const empty = await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .query({ search: "' OR true--", sortBy: 'unknownColumn' })
      .expect(200);
    expect(empty.body).toMatchObject({ data: [], total: 0 });
    await request(app.server)
      .get(path('invalid'))
      .set(owner.headers)
      .expect(400);
  });
  it('accepts either read alias and denies missing permissions, anonymous access and foreign/missing projects', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    for (const key of ['group.read', 'project.read']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[key], role],
      );
      await request(app.server).get(path(project)).set(headers).expect(200);
    }
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [[], role],
    );
    await request(app.server).get(path(project)).set(headers).expect(403);
    await request(app.server)
      .get(path(project))
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
    for (const id of [foreign, randomUUID()])
      await request(app.server).get(path(id)).set(owner.headers).expect(404);
  });
  it('leaves legacy member JSON, stored membership and rules unchanged', async () => {
    const legacyPath = '/api/asset-group/' + project + '/assets';
    const before = await request(app.server)
      .get(legacyPath)
      .set(owner.headers)
      .expect(200);
    expect(before.body.total).toBe(2);
    expect(before.body.data[0]).not.toHaveProperty('source');
    const members = await app.dataSource.query(
      'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
      [project],
    );
    const rules = await app.dataSource.query(
      'SELECT * FROM project_scope_rules WHERE "projectId"=$1 ORDER BY id',
      [project],
    );
    await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .query({ source: 'rule' })
      .expect(200);
    const after = await request(app.server)
      .get(legacyPath)
      .set(owner.headers)
      .expect(200);
    expect(after.body).toEqual(before.body);
    expect(
      await app.dataSource.query(
        'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
        [project],
      ),
    ).toEqual(members);
    expect(
      await app.dataSource.query(
        'SELECT * FROM project_scope_rules WHERE "projectId"=$1 ORDER BY id',
        [project],
      ),
    ).toEqual(rules);
  });
});
