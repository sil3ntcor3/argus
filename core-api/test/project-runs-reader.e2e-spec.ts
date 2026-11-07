import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { JobRunType } from '../src/common/enums/enum';
import { ProjectRunReadService } from '../src/modules/projects/project-run-read.service';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Private project run reader (e2e)', () => {
  let app: TestApp, service: ProjectRunReadService;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let project: string, sibling: string, binding: string, foreignBinding: string;
  let assetId: string;
  const runs: string[] = [];
  // Fixture table/column names below are literals; bind every stored value.
  const insert = async (table: string, values: Record<string, unknown>) => {
    const columns = Object.keys(values).map((key) => `"${key}"`);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const [{ id }] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders.join(',')}) RETURNING id`,
      Object.values(values),
    );
    return id;
  };
  const list = (
    query: Partial<Parameters<ProjectRunReadService['list']>[2]> = {},
  ) =>
    service.list(project, owner.workspace.id, { page: 1, limit: 10, ...query });
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    service = app.app.get(ProjectRunReadService);
    owner = await createUserWithWorkspace(app.server, 'run-reader-owner');
    other = await createUserWithWorkspace(app.server, 'run-reader-other');
    const workspaceId = owner.workspace.id;
    const makeProject = () =>
      insert('projects', { name: randomUUID(), workspaceId });
    project = await makeProject();
    sibling = await makeProject();
    const makeWorkflow = (workspaceId: string) =>
      insert('workflows', {
        workspaceId,
        name: 'Argus run reader',
        filePath: randomUUID() + '.yaml',
        content: {
          name: 'Argus run reader',
          jobs: {
            probe: { run: 'httpx' },
            scan: { run: 'nuclei', config: { token: 'secret' } },
          },
        },
      });
    const workflowId = await makeWorkflow(workspaceId);
    const foreignWorkflow = await makeWorkflow(other.workspace.id);
    binding = await insert('project_workflows', {
      projectId: project,
      workflowId,
    });
    foreignBinding = await insert('project_workflows', {
      projectId: sibling,
      workflowId,
    });
    const value = randomUUID() + '.argus.test';
    const targetId = await insert('targets', {
      value,
      type: 'DOMAIN',
      workspaceId,
    });
    assetId = await insert('assets', { value, targetId });
    const [{ id: toolId }] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM tools WHERE name=$1 LIMIT 1',
      ['nuclei'],
    );
    const run = (day: number, override: Record<string, unknown> = {}) =>
      insert('job_histories', {
        workflowId,
        projectId: project,
        projectWorkflowId: binding,
        jobRunType: JobRunType.MANUAL,
        createdAt: `2026-03-${String(day).padStart(2, '0')} 00:00:00`,
        ...override,
      });
    runs.push(
      await run(1, {
        scope: { assetIds: [assetId], targetIds: [targetId] },
        steps: {
          probe: { status: 'done' },
          scan: { status: 'skipped', reason: 'no-inputs' },
          again: { status: 'failed' },
        },
      }),
    );
    runs.push(
      await run(2, {
        jobRunType: JobRunType.SCHEDULED,
        scope: { targetIds: [targetId] },
      }),
    );
    runs.push(
      await run(2, { projectWorkflowId: null, scope: { assetIds: 'invalid' } }),
    );
    await run(8, { projectId: sibling, projectWorkflowId: foreignBinding });
    await run(9, { projectId: null, projectWorkflowId: null });
    await run(10, { workflowId: foreignWorkflow });
    for (const [i, statuses] of [
      ['completed'],
      ['failed', 'cancelled'],
      ['skipped'],
    ].entries())
      for (const status of statuses)
        await insert('jobs', {
          jobHistoryId: runs[i],
          assetId,
          toolId,
          category: 'vulnerabilities',
          status,
        });
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  it('isolates run history and keeps deterministic page order, including detached history', async () => {
    const order = [...runs.slice(1).sort().reverse(), runs[0]];
    for (const [i, id] of order.entries()) {
      const page = await list({ limit: 1, page: i + 1 });
      expect(page).toMatchObject({
        total: 3,
        page: i + 1,
        limit: 1,
        pageCount: 3,
        hasNextPage: i < 2,
      });
      expect(page.data.map((row) => row.id)).toEqual([id]);
    }
    expect(await list({ limit: 1, page: 4 })).toMatchObject({
      total: 3,
      data: [],
      hasNextPage: false,
    });
    expect(
      (await list({ projectWorkflowId: binding })).data.map((row) => row.id),
    ).toEqual([runs[1], runs[0]]);
    await app.dataSource.query(
      'UPDATE job_histories SET "projectWorkflowId"=$1 WHERE id=$2',
      [foreignBinding, runs[2]],
    );
    try {
      expect((await list({ projectWorkflowId: foreignBinding })).total).toBe(0);
      expect(
        (await list()).data.find((row) => row.id === runs[2])
          ?.projectWorkflowId,
      ).toBeNull();
    } finally {
      await app.dataSource.query(
        'UPDATE job_histories SET "projectWorkflowId"=NULL WHERE id=$1',
        [runs[2]],
      );
    }
    expect(
      (await list({ jobRunType: JobRunType.SCHEDULED })).data.map(
        (row) => row.id,
      ),
    ).toEqual([runs[1]]);
  });
  it('derives status, scope and step summaries without exposing stored configs or IDs', async () => {
    const result = await list();
    const rows = runs.map((id) => result.data.find((row) => row.id === id));
    expect(rows[0]).toMatchObject({
      status: 'completed',
      newVulnerabilities: 0,
      recurringVulnerabilities: 0,
      scopeSize: 1,
      stepsTotal: 3,
      stepsDone: 2,
      stepsFailed: 1,
    });
    expect(rows[1]).toMatchObject({
      status: 'cancelled',
      scopeSize: 1,
      stepsTotal: 2,
      stepsDone: 0,
      stepsFailed: 0,
    });
    expect(rows[2]).toMatchObject({
      status: 'skipped',
      scopeSize: 0,
      projectWorkflowId: null,
    });
    for (const row of rows)
      for (const key of ['scope', 'steps', 'workflowContent', 'projectId'])
        expect(row).not.toHaveProperty(key);
    expect(JSON.stringify(rows)).not.toContain('secret');
  });
  it('counts exact intermediate sightings and legacy run pointers once per owned finding', async () => {
    const value = randomUUID() + '.argus.test';
    const targetId = await insert('targets', {
      value,
      type: 'DOMAIN',
      workspaceId: other.workspace.id,
    });
    const foreignAssetId = await insert('assets', { value, targetId });
    const links: string[] = [];
    const fixtures: [string, string, string | null, string, string[]][] = [
      [project, assetId, runs[0], runs[2], runs],
      [project, assetId, runs[0], runs[1], []],
      [sibling, assetId, runs[0], runs[1], [runs[1]]],
      [project, foreignAssetId, runs[0], runs[1], [runs[1]]],
      [project, assetId, runs[0], runs[0], [runs[0]]],
      [project, assetId, null, runs[2], [runs[2]]],
    ];
    for (const [
      projectId,
      findingAsset,
      firstSeenJobHistoryId,
      lastSeenJobHistoryId,
      seen,
    ] of fixtures) {
      const vulnerabilityId = await insert('vulnerabilities', {
        name: randomUUID(),
        severity: 'high',
        assetId: findingAsset,
      });
      const link = await insert('project_vulnerabilities', {
        projectId,
        vulnerabilityId,
        firstSeenJobHistoryId,
        lastSeenJobHistoryId,
        timesSeen: Math.max(
          firstSeenJobHistoryId === lastSeenJobHistoryId ? 1 : 2,
          seen.length,
        ),
      });
      links.push(link);
      for (const jobHistoryId of seen)
        await insert('project_vulnerability_observations', {
          projectVulnerabilityId: link,
          jobHistoryId,
        });
    }
    const snapshot = () =>
      Promise.all([
        app.dataSource.query(
          'SELECT * FROM project_vulnerabilities WHERE id=ANY($1::uuid[]) ORDER BY id',
          [links],
        ),
        app.dataSource.query(
          'SELECT * FROM project_vulnerability_observations WHERE "projectVulnerabilityId"=ANY($1::uuid[]) ORDER BY id',
          [links],
        ),
      ]);
    const before = await snapshot(),
      result = await list();
    expect(
      runs.map((id) => {
        const row = result.data.find((r) => r.id === id);
        return [row?.newVulnerabilities, row?.recurringVulnerabilities];
      }),
    ).toEqual([
      [3, 0],
      [0, 2],
      [0, 2],
    ]);
    const scheduled = await list({
      limit: 1,
      jobRunType: JobRunType.SCHEDULED,
    });
    expect(scheduled).toMatchObject({
      total: 1,
      hasNextPage: false,
      data: [
        { id: runs[1], newVulnerabilities: 0, recurringVulnerabilities: 2 },
      ],
    });
    const activity = await service.listActivity(project, owner.workspace.id);
    expect(activity.map((item) => item.ref)).toEqual([
      ...runs.slice(1).sort().reverse(),
      runs[0],
    ]);
    expect(activity.find((item) => item.ref === runs[1])).toMatchObject({
      kind: 'run',
      jobRunType: 'scheduled',
      runStatus: 'cancelled',
      scopeSize: 1,
      newVulnerabilities: 0,
      recurringVulnerabilities: 2,
    });
    expect(Object.keys(activity[0]).sort()).toEqual([
      'at',
      'jobRunType',
      'kind',
      'newVulnerabilities',
      'recurringVulnerabilities',
      'ref',
      'runStatus',
      'scopeSize',
      'workflowName',
    ]);
    expect(await snapshot()).toEqual(before);
  });
  it('bounds recent run activity and interprets stored timestamps in the database timezone', async () => {
    const runner = app.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const m = runner.manager;
      await m.query("SET LOCAL TIME ZONE 'America/Chicago'");
      const [{ id }] = await m.query<{ id: string }[]>(
        'INSERT INTO projects (name, "workspaceId") VALUES ($1,$2) RETURNING id',
        [randomUUID(), owner.workspace.id],
      );
      await m.query(
        `INSERT INTO job_histories ("workflowId","projectId","createdAt","isCompleted")
        SELECT h."workflowId",$1,TIMESTAMP '2026-03-02 00:00:00'+i*interval '1 minute',true
        FROM job_histories h CROSS JOIN generate_series(1,16) i WHERE h.id=$2`,
        [id, runs[0]],
      );
      const activity = await service.listActivity(id, owner.workspace.id, m);
      expect(activity).toHaveLength(15);
      expect(activity[0].at.toISOString()).toBe('2026-03-02T06:16:00.000Z');
      expect(activity[14].at.toISOString()).toBe('2026-03-02T06:02:00.000Z');
      await expect(
        service.listActivity(id, other.workspace.id, m),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('rejects missing projects, foreign workspaces and unsafe paging', async () => {
    for (const [id, workspace] of [
      [project, other.workspace.id],
      [randomUUID(), owner.workspace.id],
    ])
      await expect(
        service.list(id, workspace, { page: 1, limit: 10 }),
      ).rejects.toMatchObject({ status: 404 });
    for (const query of [
      { page: 0 },
      { page: 1.5 },
      { limit: 101 },
      { page: Number.MAX_SAFE_INTEGER, limit: 10 },
    ])
      await expect(list(query)).rejects.toMatchObject({ status: 400 });
  });
  const api = (id = project) => `/api/projects/${id}/runs`;

  it('returns paged run summaries through the canonical endpoint with a safe exact shape', async () => {
    const get = (query: Record<string, string | number>) =>
      request(app.server)
        .get(api(project.toUpperCase()))
        .set(owner.headers)
        .query(query)
        .expect(200);
    const scheduled = await get({ jobRunType: 'scheduled', limit: 1 });
    expect(scheduled.body).toMatchObject({
      total: 1,
      page: 1,
      limit: 1,
      pageCount: 1,
      hasNextPage: false,
      data: [
        {
          id: runs[1],
          status: 'cancelled',
          jobRunType: 'scheduled',
          projectWorkflowId: binding,
          scopeSize: 1,
          stepsTotal: 2,
          stepsDone: 0,
          stepsFailed: 0,
          newVulnerabilities: expect.any(Number),
          recurringVulnerabilities: expect.any(Number),
        },
      ],
    });
    expect(Object.keys(scheduled.body.data[0]).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'isCompleted',
        'jobRunType',
        'projectWorkflowId',
        'workflowName',
        'status',
        'scopeSize',
        'stepsTotal',
        'stepsDone',
        'stepsFailed',
        'newVulnerabilities',
        'recurringVulnerabilities',
      ].sort(),
    );
    expect((await get({ limit: 1, page: 4 })).body).toMatchObject({
      total: 3,
      data: [],
      hasNextPage: false,
    });
    expect(
      (await get({ projectWorkflowId: foreignBinding })).body,
    ).toMatchObject({ total: 0, data: [], pageCount: 0 });
    const bound = await get({ projectWorkflowId: binding });
    expect(bound.body.data.map((row: { id: string }) => row.id)).toEqual([
      runs[1],
      runs[0],
    ]);
    await request(app.server)
      .get('/api/jobs-registry/histories/' + runs[0])
      .set(owner.headers)
      .expect(200);
  });

  it('validates path and query inputs and denies anonymous and foreign project reads', async () => {
    for (const query of [
      { page: 0 },
      { page: 1.5 },
      { limit: 0 },
      { limit: 101 },
      { jobRunType: 'invalid' },
      { projectWorkflowId: 'invalid' },
    ])
      await request(app.server)
        .get(api())
        .set(owner.headers)
        .query(query)
        .expect(400);
    await request(app.server)
      .get(api('invalid'))
      .set(owner.headers)
      .expect(400);
    await request(app.server)
      .get(api())
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
    for (const id of [project, randomUUID()])
      await request(app.server).get(api(id)).set(other.headers).expect(404);
  });

  it('accepts both project read aliases and rejects callers without membership or permission', async () => {
    const workspaceId = owner.workspace.id;
    await request(app.server)
      .get(api())
      .set({ ...other.headers, 'X-Workspace-Id': workspaceId })
      .expect(403);
    const memberId = await insert('workspace_members', {
      workspaceId,
      userId: other.user.userId,
    });
    const permissionId = await insert('workspace_permissions', {
      workspaceId,
      name: randomUUID(),
      permissions: ['project.read'],
    });
    await insert('workspace_member_permissions', { memberId, permissionId });
    const headers = { ...other.headers, 'X-Workspace-Id': workspaceId };
    for (const permission of ['project.read', 'group.read']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[permission], permissionId],
      );
      await request(app.server).get(api()).set(headers).expect(200);
    }
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [[], permissionId],
    );
    await request(app.server).get(api()).set(headers).expect(403);
  });
});
