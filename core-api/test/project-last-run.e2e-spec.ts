import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project run attribution (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let workflow: string,
    foreign: string,
    asset: string,
    tool: string,
    first: string,
    second: string,
    standalone: string;
  const projects: string[] = [],
    bindings: string[] = [];
  const prefix = 'Argus run ' + randomUUID();
  const at = (day: number) =>
    new Date('2026-03-' + String(day).padStart(2, '0') + 'T00:00:00Z');
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const history = async (
    w: string,
    project: string | null,
    binding: string | null,
    day: number,
    status?: string,
  ) => {
    const id = await insert(
      'INSERT INTO job_histories ("workflowId","projectId","projectWorkflowId","createdAt") VALUES ($1,$2,$3,$4)',
      [w, project, binding, at(day)],
    );
    if (status)
      await app.dataSource.query(
        'INSERT INTO jobs ("jobHistoryId","assetId","toolId",category,status) VALUES ($1,$2,$3,$4,$5)',
        [id, asset, tool, 'vulnerabilities', status],
      );
    return id;
  };
  const get = (id: string, prefix = 'projects') =>
    request(app.server)
      .get('/api/' + prefix + '/' + id)
      .set(owner.headers);
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'last-run-owner');
    other = await createUserWithWorkspace(app.server, 'last-run-other');
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['last-run.argus.test', 'DOMAIN', owner.workspace.id],
    );
    asset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['last-run.argus.test', target],
    );
    tool = (
      await app.dataSource.query<{ id: string }[]>(
        'SELECT id FROM tools WHERE name=$1 LIMIT 1',
        ['nuclei'],
      )
    )[0].id;
    const makeWorkflow = (workspace: string) =>
      insert(
        'INSERT INTO workflows (name,content,"filePath","workspaceId") VALUES ($1,$2,$3,$4)',
        [
          randomUUID(),
          JSON.stringify({ name: 'Argus scoped runs', jobs: {} }),
          randomUUID() + '.yaml',
          workspace,
        ],
      );
    workflow = await makeWorkflow(owner.workspace.id);
    const foreignWorkflow = await makeWorkflow(other.workspace.id);
    for (const label of ['A', 'B', 'C', 'D'])
      projects.push(
        await insert(
          'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
          [prefix + ' ' + label, owner.workspace.id],
        ),
      );
    foreign = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [prefix + ' foreign', other.workspace.id],
    );
    for (const index of [0, 1, 3])
      bindings[index] = await insert(
        'INSERT INTO project_workflows ("projectId","workflowId") VALUES ($1,$2)',
        [projects[index], workflow],
      );
    first = await history(workflow, projects[0], bindings[0], 1, 'completed');
    second = await history(workflow, projects[1], bindings[1], 2, 'failed');
    standalone = await history(workflow, null, null, 10, 'completed');
    await history(foreignWorkflow, projects[0], bindings[0], 12, 'completed');
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  it('uses persisted project and binding provenance while leaving legacy shared-workflow JSON unchanged', async () => {
    const before = await get(projects[0], 'asset-group').expect(200);
    expect(before.body.assetGroupWorkflows[0].lastRun.id).toBe(standalone);
    for (const [index, run, status] of [
      [0, first, 'completed'],
      [1, second, 'failed'],
    ] as const) {
      const response = await get(projects[index].toUpperCase()).expect(200);
      expect(response.body).toMatchObject({
        lastRunAt: at(index + 1).toISOString(),
        totalAssets: 0,
      });
      expect(response.body.assetGroupWorkflows[0].lastRun).toMatchObject({
        id: run,
        totalJobs: 1,
        status,
      });
      expect(response.body.assetGroupWorkflows[0].lastRun).not.toHaveProperty(
        'projectId',
      );
      expect(response.body.assetGroupWorkflows[0].lastRun).not.toHaveProperty(
        'projectWorkflowId',
      );
    }
    const after = await get(projects[0], 'asset-group').expect(200);
    expect(after.body).toEqual(before.body);
  });
  it('orders project times before paging, keeps unknown runs last and breaks ties deterministically', async () => {
    const legacyQuery = {
      search: prefix,
      sortBy: 'lastRunAt',
      sortOrder: 'DESC',
    };
    const legacyBefore = await request(app.server)
      .get('/api/asset-group')
      .set(owner.headers)
      .query(legacyQuery)
      .expect(200);
    const list = (page: number) =>
      request(app.server).get('/api/projects').set(owner.headers).query({
        search: prefix,
        sortBy: 'lastRunAt',
        sortOrder: 'DESC',
        page,
        limit: 1,
      });
    const expected = [projects[1], projects[0], ...projects.slice(2).sort()];
    for (const [index, id] of expected.entries()) {
      const response = await list(index + 1).expect(200);
      expect(response.body.total).toBe(4);
      expect(response.body.data[0].id).toBe(id);
    }
    await app.dataSource.query(
      'UPDATE job_histories SET "createdAt"=$1 WHERE id=$2',
      [at(1), second],
    );
    try {
      const ids = [];
      for (const page of [1, 2])
        ids.push((await list(page).expect(200)).body.data[0].id);
      expect(ids).toEqual(projects.slice(0, 2).sort());
    } finally {
      await app.dataSource.query(
        'UPDATE job_histories SET "createdAt"=$1 WHERE id=$2',
        [at(2), second],
      );
    }
    const legacyAfter = await request(app.server)
      .get('/api/asset-group')
      .set(owner.headers)
      .query(legacyQuery)
      .expect(200);
    expect(legacyAfter.body).toEqual(legacyBefore.body);
  });
  it('returns null for projects without attributed runs and still denies foreign or missing projects', async () => {
    const empty = await get(projects[2]).expect(200);
    expect(empty.body).toMatchObject({
      lastRunAt: null,
      totalAssets: 0,
      assetGroupWorkflows: [],
    });
    const shared = await get(projects[3]).expect(200);
    expect(shared.body.lastRunAt).toBeNull();
    expect(shared.body.assetGroupWorkflows[0].lastRun).toBeNull();
    for (const id of [foreign, randomUUID()]) await get(id).expect(404);
    await get('invalid').expect(400);
    await request(app.server)
      .get('/api/projects/' + projects[0])
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
  });
  it('keeps project history after detaching a binding without attributing it to a replacement or inventing zero-job status', async () => {
    await app.dataSource.query('DELETE FROM project_workflows WHERE id=$1', [
      bindings[0],
    ]);
    bindings[0] = await insert(
      'INSERT INTO project_workflows ("projectId","workflowId") VALUES ($1,$2)',
      [projects[0], workflow],
    );
    const response = await get(projects[0]).expect(200);
    expect(response.body.lastRunAt).toBe(at(1).toISOString());
    expect(response.body.assetGroupWorkflows[0].lastRun).toBeNull();
    await history(workflow, projects[0], bindings[0], 5);
    const zero = await get(projects[0]).expect(200);
    expect(zero.body.lastRunAt).toBe(at(5).toISOString());
    expect(zero.body.assetGroupWorkflows[0].lastRun).toBeNull();
    expect(
      (await get(projects[0], 'asset-group').expect(200)).body
        .assetGroupWorkflows[0].lastRun.id,
    ).toBe(standalone);
  });
});
