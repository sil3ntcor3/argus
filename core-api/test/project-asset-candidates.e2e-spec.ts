import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project asset candidates (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let project: string, otherProject: string, foreign: string, role: string;
  const assets: string[] = [];
  const path = (id: string) => '/api/projects/' + id + '/assets/candidates';
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const snapshot = async () => ({
    members: await app.dataSource.query(
      'SELECT * FROM project_assets WHERE "projectId"=ANY($1::uuid[]) ORDER BY id',
      [[project, otherProject]],
    ),
    rules: await app.dataSource.query(
      'SELECT * FROM project_scope_rules WHERE "projectId"=$1 ORDER BY id',
      [project],
    ),
  });
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'candidates-owner');
    reader = await createUserWithWorkspace(app.server, 'candidates-reader');
    for (const [index, context] of [owner, reader].entries()) {
      const id = await insert(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
        [randomUUID(), context.workspace.id],
      );
      if (index === 0) project = id;
      else foreign = id;
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['candidates.argus.test', 'DOMAIN', context.workspace.id],
      );
      for (const name of index === 0
        ? ['assigned', 'alpha', 'beta', 'gamma']
        : ['beta'])
        assets.push(
          await insert(
            'INSERT INTO assets (value,"targetId","isEnabled",metadata) VALUES ($1,$2,$3,$4)',
            [
              name + '.candidates.argus.test',
              target,
              name !== 'gamma',
              name === 'beta'
                ? JSON.stringify({ label: 'Argus candidate' })
                : null,
            ],
          ),
        );
    }
    otherProject = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2),($3,$4)',
      [project, assets[0], otherProject, assets[2]],
    );
    await app.dataSource.query(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'asset', assets[3]],
    );
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      ['Candidate reader', ['project.read'], owner.workspace.id],
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
  it('pages owned nonmembers, permits membership in another project and preserves asset flags/metadata', async () => {
    const query = { page: 1, limit: 2, sortBy: 'value', sortOrder: 'ASC' };
    const response = await request(app.server)
      .get(path(project.toUpperCase()))
      .set(owner.headers)
      .query(query)
      .expect(200);
    expect(response.body).toMatchObject({
      total: 3,
      page: 1,
      limit: 2,
      pageCount: 2,
      hasNextPage: true,
    });
    expect(response.body.data.map((row: { id: string }) => row.id)).toEqual([
      assets[1],
      assets[2],
    ]);
    expect(response.body.data[1]).toMatchObject({
      metadata: { label: 'Argus candidate' },
      isEnabled: true,
    });
    const second = await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .query({ ...query, page: 2 })
      .expect(200);
    expect(second.body).toMatchObject({
      total: 3,
      page: 2,
      pageCount: 2,
      hasNextPage: false,
    });
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0]).toMatchObject({
      id: assets[3],
      isEnabled: false,
    });
    for (const row of [...response.body.data, ...second.body.data])
      for (const field of [
        'projectId',
        'projectWorkflowId',
        'scopeRuleId',
        'inputs',
      ])
        expect(row).not.toHaveProperty(field);
  });
  it('matches legacy search/pagination results and leaves membership and rules unchanged', async () => {
    const before = await snapshot(),
      query = {
        search: 'BETA',
        page: 1,
        limit: 10,
        sortBy: 'value',
        sortOrder: 'DESC',
      };
    const canonical = await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .query(query)
      .expect(200);
    const legacy = await request(app.server)
      .get('/api/asset-group/' + project + '/assets/not-in-group')
      .set(owner.headers)
      .query(query)
      .expect(200);
    expect(canonical.body).toEqual(legacy.body);
    expect(canonical.body.total).toBe(1);
    expect(canonical.body.data.map((row: { id: string }) => row.id)).toEqual([
      assets[2],
    ]);
    expect(await snapshot()).toEqual(before);
  });
  it('authorizes both read aliases and denies missing grants, authentication, foreign projects and invalid route IDs', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    for (const key of ['project.read', 'group.read']) {
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
    await request(app.server)
      .get(path('invalid'))
      .set(owner.headers)
      .expect(400);
  });
  it('validates paging/sort input, safely falls back for unknown columns and returns empty later pages', async () => {
    const before = await snapshot();
    for (const query of [
      { page: 0 },
      { limit: 0 },
      { limit: 101 },
      { page: 'invalid' },
      { sortOrder: 'invalid' },
      { sortBy: 'value DESC--' },
    ])
      await request(app.server)
        .get(path(project))
        .set(owner.headers)
        .query(query)
        .expect(400);
    const fallback = await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .query({ sortBy: 'unknownColumn' })
      .expect(200);
    expect(fallback.body.total).toBe(3);
    expect(
      fallback.body.data.map((row: { id: string }) => row.id).sort(),
    ).toEqual(assets.slice(1, 4).sort());
    const empty = await request(app.server)
      .get(path(project))
      .set(owner.headers)
      .query({ page: 9, limit: 2 })
      .expect(200);
    expect(empty.body).toMatchObject({
      data: [],
      total: 3,
      page: 9,
      hasNextPage: false,
    });
    expect(await snapshot()).toEqual(before);
  });
});
