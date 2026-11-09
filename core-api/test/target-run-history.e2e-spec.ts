import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Target run history API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreign: typeof owner;
  let target: string;
  let foreignTarget: string;
  let queued: string;
  let mixed: string;
  let workflowName: string;
  const earlier = '2026-01-02T03:04:05.000Z';
  const later = '2026-01-03T03:04:05.000Z';

  const read = (id: string, headers: Record<string, string>, query = '') =>
    request(app.server).get(`/api/targets/${id}/runs${query}`).set(headers);

  async function insertId(sql: string, params: unknown[]) {
    return (
      await app.dataSource.query<{ id: string }[]>(
        `${sql} RETURNING id`,
        params,
      )
    )[0].id;
  }

  function makeTarget(workspaceId: string) {
    return insertId(
      `INSERT INTO targets (value, type, "workspaceId") VALUES ($1, 'DOMAIN', $2)`,
      [`${randomUUID()}.example.test`, workspaceId],
    );
  }

  function makeRun(workflow: string, targetIds: string[], timestamp: string) {
    return insertId(
      `INSERT INTO job_histories ("workflowId", scope, "createdAt", "updatedAt") VALUES ($1, $2, $3, $3)`,
      [workflow, { targetIds }, new Date(timestamp)],
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'target-runs-owner');
    foreign = await createUserWithWorkspace(app.server, 'target-runs-foreign');
    target = await makeTarget(owner.workspace.id);
    const sibling = await makeTarget(owner.workspace.id);
    foreignTarget = await makeTarget(foreign.workspace.id);
    const [workflow] = await app.dataSource.query<
      { id: string; name: string }[]
    >(`SELECT id, name FROM workflows WHERE "workspaceId" = $1 LIMIT 1`, [
      owner.workspace.id,
    ]);
    const [otherWorkflow] = await app.dataSource.query<{ id: string }[]>(
      `SELECT id FROM workflows WHERE "workspaceId" = $1 LIMIT 1`,
      [foreign.workspace.id],
    );
    const [tool] = await app.dataSource.query<{ id: string }[]>(
      `SELECT id FROM tools WHERE name = 'nuclei'`,
    );
    workflowName = workflow.name;
    queued = await makeRun(workflow.id, [target], later);
    mixed = await makeRun(workflow.id, [sibling], earlier);
    await makeRun(workflow.id, [sibling], later);
    // A cross-workspace scope reference must never surface a foreign run.
    await makeRun(otherWorkflow.id, [target], later);
    const assetSql = 'INSERT INTO assets (value, "targetId") VALUES ($1, $2)';
    const asset = await insertId(assetSql, ['owned.example.test', target]);
    const siblingAsset = await insertId(assetSql, [
      'sibling.example.test',
      sibling,
    ]);
    for (const [id, status] of [
      [asset, 'completed'],
      [asset, 'skipped'],
      [asset, 'pending'],
      [asset, 'in_progress'],
      [siblingAsset, 'failed'],
    ]) {
      await app.dataSource.query(
        `INSERT INTO jobs ("jobHistoryId", "assetId", "toolId", category, status) VALUES ($1, $2, $3, 'vulnerabilities', $4)`,
        [mixed, id, tool.id, status],
      );
    }
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, foreign?.workspace.id].filter(
          Boolean,
        ),
        userIds: [owner?.user.userId, foreign?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('lists recorded and scanned targets with per-target job counts and stable pagination', async () => {
    const common = { limit: 1, total: 2, pageCount: 2 };
    const run = (id: string, time: string) => ({
      id,
      createdAt: time,
      updatedAt: time,
      jobRunType: 'manual',
      workflowName,
      projectId: null,
      projectName: null,
      newVulnerabilities: 0,
    });
    await read(target, owner.headers, '?limit=1')
      .expect(200, {
        ...common,
        page: 1,
        hasNextPage: true,
        data: [
          {
            ...run(queued, later),
            status: 'pending',
            jobsTotal: 0,
            jobsDone: 0,
            jobsFailed: 0,
            jobsRunning: 0,
            currentTool: null,
          },
        ],
      })
      .expect('Cache-Control', 'private, no-store');
    await read(target, owner.headers, '?limit=1&page=2').expect(200, {
      ...common,
      page: 2,
      hasNextPage: false,
      data: [
        {
          ...run(mixed, earlier),
          status: 'failed',
          jobsTotal: 4,
          jobsDone: 2,
          jobsFailed: 0,
          jobsRunning: 1,
          currentTool: 'nuclei',
        },
      ],
    });
    await read(target, owner.headers, '?limit=1&page=3').expect(200, {
      ...common,
      page: 3,
      hasNextPage: false,
      data: [],
    });
    const empty = await read(foreignTarget, foreign.headers).expect(200);
    expect(empty.body).toMatchObject({ total: 0, data: [], limit: 10 });
  });

  it('validates pagination and hides foreign or missing targets', async () => {
    await read(target, owner.headers, '?page=1.2').expect(400);
    await read(target, owner.headers, '?limit=101').expect(400);
    await read('not-an-id', owner.headers).expect(400);
    const missing = await read(randomUUID(), owner.headers).expect(404);
    const other = await read(foreignTarget, owner.headers).expect(404);
    expect(other.body).toEqual(missing.body);
  });

  it('uses workspace-scoped run project provenance in Activity and Overview', async () => {
    const workspace = owner.workspace.id;
    const id = await makeTarget(workspace);
    const [workflow] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId" = $1 LIMIT 1',
      [workspace],
    );
    const projectName = 'Archived target run project';
    const projectId = await insertId(
      'INSERT INTO projects (name, "workspaceId", "archivedAt") VALUES ($1, $2, now())',
      [projectName, workspace],
    );
    const foreignProject = await insertId(
      'INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)',
      ['Foreign target run project', foreign.workspace.id],
    );
    const now = Date.now();
    const linked = await makeRun(
      workflow.id,
      [id],
      new Date(now).toISOString(),
    );
    const foreignLinked = await makeRun(
      workflow.id,
      [id],
      new Date(now - 60_000).toISOString(),
    );
    const unlinked = await makeRun(
      workflow.id,
      [id],
      new Date(now - 120_000).toISOString(),
    );
    for (const [run, project] of [
      [linked, projectId],
      [foreignLinked, foreignProject],
    ]) {
      await app.dataSource.query(
        'UPDATE job_histories SET "projectId" = $1 WHERE id = $2',
        [project, run],
      );
    }

    const activity = await read(id, owner.headers).expect(200);
    expect(activity.body.data).toMatchObject([
      { id: linked, projectId, projectName },
      { id: foreignLinked, projectId: null, projectName: null },
      { id: unlinked, projectId: null, projectName: null },
    ]);
    const overview = await request(app.server)
      .get(`/api/targets/${id}/overview`)
      .set(owner.headers)
      .expect(200);
    expect(overview.body.lastRun).toEqual(activity.body.data[0]);
    expect(overview.body.activeRuns).toEqual(activity.body.data);
  });

  it('counts original target findings per run, including archived and dismissed discoveries', async () => {
    const workspace = owner.workspace.id;
    const id = await makeTarget(workspace);
    const sibling = await makeTarget(workspace);
    const [workflow] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId" = $1 LIMIT 1',
      [workspace],
    );
    const now = Date.now();
    const run = await makeRun(workflow.id, [id], new Date(now).toISOString());
    const otherRun = await makeRun(
      workflow.id,
      [id],
      new Date(now - 60_000).toISOString(),
    );
    const assetSql = 'INSERT INTO assets (value, "targetId") VALUES ($1, $2)';
    const asset = await insertId(assetSql, ['run-findings.example.test', id]);
    const siblingAsset = await insertId(assetSql, [
      'run-findings-sibling.example.test',
      sibling,
    ]);
    for (const [history, assetId, archived, dismissed] of [
      [run, asset, false, false],
      [run, asset, true, false],
      [run, asset, false, true],
      [run, siblingAsset, false, false],
      [otherRun, asset, false, false],
      [null, asset, false, false],
    ] as const) {
      const finding = await insertId(
        `INSERT INTO vulnerabilities (name, "assetId", "jobHistoryId", "isArchived")
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), assetId, history, archived],
      );
      if (dismissed) {
        await app.dataSource.query(
          `INSERT INTO vulnerability_dismissals ("vulnerabilityId", "userId", reason)
           VALUES ($1, $2, $3)`,
          [finding, owner.user.userId, 'Fixture dismissal'],
        );
      }
    }
    const activity = await read(id, owner.headers).expect(200);
    expect(activity.body.data).toMatchObject([
      { id: run, newVulnerabilities: 3 },
      { id: otherRun, newVulnerabilities: 1 },
    ]);
    const overview = await request(app.server)
      .get(`/api/targets/${id}/overview`)
      .set(owner.headers)
      .expect(200);
    expect(overview.body.lastRun).toEqual(activity.body.data[0]);
    expect(overview.body.activeRuns).toEqual(activity.body.data);
  });

  it('shares the latest running tool on this target between Activity and Overview', async () => {
    const workspace = owner.workspace.id;
    const id = await makeTarget(workspace);
    const sibling = await makeTarget(workspace);
    const [workflow] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId" = $1 LIMIT 1',
      [workspace],
    );
    const now = Date.now();
    const run = await makeRun(workflow.id, [id], new Date(now).toISOString());
    const assetSql = 'INSERT INTO assets (value, "targetId") VALUES ($1, $2)';
    const asset = await insertId(assetSql, ['current-tool.example.test', id]);
    const siblingAsset = await insertId(assetSql, [
      'current-tool-sibling.example.test',
      sibling,
    ]);
    for (const [jobId, assetId, tool, status, minutes] of [
      [randomUUID(), asset, 'nuclei', 'in_progress', 3],
      ['00000000-0000-4000-8000-000000000011', asset, 'httpx', 'in_progress', 2],
      ['00000000-0000-4000-8000-000000000012', asset, 'naabu', 'in_progress', 2],
      [randomUUID(), asset, 'nuclei', 'in_progress', null],
      [randomUUID(), asset, 'nuclei', 'completed', 1],
      [randomUUID(), siblingAsset, 'httpx', 'in_progress', 1],
    ] as const) {
      const pickedAt = minutes === null ? null : new Date(now - minutes * 60_000);
      await insertId(
        `INSERT INTO jobs (id, "jobHistoryId", "assetId", "toolId", category, status, "pickJobAt")
         SELECT $1, $2, $3, id, 'vulnerabilities', $4, $5 FROM tools WHERE name = $6`,
        [jobId, run, assetId, status, pickedAt, tool],
      );
    }
    const activity = await read(id, owner.headers).expect(200);
    expect(activity.body.data).toMatchObject([
      { id: run, currentTool: 'naabu', jobsRunning: 4 },
    ]);
    const overview = await request(app.server)
      .get(`/api/targets/${id}/overview`)
      .set(owner.headers)
      .expect(200);
    expect(overview.body.lastRun).toEqual(activity.body.data[0]);
    expect(overview.body.activeRuns).toEqual(activity.body.data);

    await app.dataSource.query(
      `UPDATE jobs SET status = 'completed' WHERE "jobHistoryId" = $1 AND "assetId" = $2`,
      [run, asset],
    );
    const siblingOnly = await read(id, owner.headers).expect(200);
    expect(siblingOnly.body.data).toMatchObject([
      { id: run, currentTool: null, jobsRunning: 0, status: 'in_progress' },
    ]);
  });

  it('filters recent unfinished runs by whole-run status before pagination', async () => {
    const id = await makeTarget(owner.workspace.id);
    const sibling = await makeTarget(owner.workspace.id);
    const [workflow] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId" = $1 LIMIT 1',
      [owner.workspace.id],
    );
    const makeHistory = (days: number, finished = false) =>
      insertId(
        `INSERT INTO job_histories ("workflowId", scope, "createdAt", "isCompleted")
         VALUES ($1, $2, LOCALTIMESTAMP - $3 * INTERVAL '1 day', $4)`,
        [workflow.id, { targetIds: [id] }, days, finished],
      );
    const failed = await makeHistory(0);
    await makeHistory(0.5, true);
    const pending = await makeHistory(1);
    const running = await makeHistory(2);
    await makeHistory(8);
    const [tool] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM tools WHERE name = $1',
      ['nuclei'],
    );
    const assetSql = 'INSERT INTO assets (value, "targetId") VALUES ($1, $2)';
    const asset = await insertId(assetSql, ['active.example.test', id]);
    const siblingAsset = await insertId(assetSql, [
      'sibling.example.test',
      sibling,
    ]);
    await app.dataSource.query(
      `INSERT INTO jobs ("jobHistoryId", "assetId", "toolId", category, status)
       VALUES ($1, $3, $5, 'vulnerabilities', 'in_progress'),
              ($1, $4, $5, 'vulnerabilities', 'failed'),
              ($2, $3, $5, 'vulnerabilities', 'in_progress')`,
      [failed, running, asset, siblingAsset, tool.id],
    );

    const first = await read(id, owner.headers, '?active=true&limit=1').expect(
      200,
    );
    const second = await read(
      id,
      owner.headers,
      '?active=true&limit=1&page=2',
    ).expect(200);
    const beyond = await read(
      id,
      owner.headers,
      '?active=true&limit=1&page=3',
    ).expect(200);
    expect(first.body).toMatchObject({
      page: 1,
      total: 2,
      hasNextPage: true,
      data: [{ id: pending, status: 'pending' }],
    });
    expect(second.body).toMatchObject({
      page: 2,
      total: 2,
      hasNextPage: false,
      data: [{ id: running, status: 'in_progress' }],
    });
    expect(beyond.body).toMatchObject({ page: 3, total: 2, data: [] });
    const full = await read(id, owner.headers).expect(200);
    expect(full.body.total).toBe(5);
    const unfiltered = await read(id, owner.headers, '?active=false').expect(200);
    expect(unfiltered.body).toEqual(full.body);
    await read(id, owner.headers, '?active=1').expect(400);
    await read(id, owner.headers, '?active=true&active=false').expect(400);
    await read(id, foreign.headers, '?active=true').expect(404);

    for (const days of [3, 4, 5, 6, 6.5]) await makeHistory(days);
    const [foreignWorkflow] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId" = $1 LIMIT 1',
      [foreign.workspace.id],
    );
    await makeRun(foreignWorkflow.id, [id], new Date().toISOString());
    const active = await read(id, owner.headers, '?active=true&limit=5').expect(
      200,
    );
    expect(active.body).toMatchObject({
      total: 7,
      hasNextPage: true,
    });
    const { data } = active.body as { data: unknown[] };
    expect(data).toHaveLength(5);
    expect(data.slice(0, 2)).toMatchObject([
      { id: pending, status: 'pending' },
      { id: running, status: 'in_progress', jobsRunning: 1 },
    ]);
    const overview = await request(app.server)
      .get(`/api/targets/${id}/overview`)
      .set(owner.headers)
      .expect(200);
    expect(overview.body).toMatchObject({
      lastRun: { id: failed, status: 'failed' },
      activeRuns: data,
    });
  });

  it('requires target and job read access in the selected workspace', async () => {
    const workspace = owner.workspace.id;
    const headers = wsHeaders(foreign.user.cookie, workspace);
    await read(target, {}).expect(401);
    await read(target, headers).expect(403);
    const member = await insertId(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2)',
      [workspace, foreign.user.userId],
    );
    const role = await insertId(
      'INSERT INTO workspace_permissions (name, permissions, "workspaceId") VALUES ($1, $2, $3)',
      [randomUUID(), ['target.read'], workspace],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)',
      [member, role],
    );
    await read(target, headers).expect(403);
    for (const [keys, status] of [
      [['job.read'], 403],
      [['target.read', 'job.read'], 200],
      [['target.write', 'job.write'], 200],
    ] as const) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [keys, role],
      );
      await read(target, headers).expect(status);
    }

    const projectName = 'Run project access test';
    const projectId = await insertId(
      'INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)',
      [projectName, workspace],
    );
    await app.dataSource.query(
      'UPDATE job_histories SET "projectId" = $1 WHERE id = $2',
      [projectId, queued],
    );
    await app.dataSource.query(
      `INSERT INTO vulnerabilities (name, "assetId", "jobHistoryId")
       SELECT $1, id, $2 FROM assets WHERE "targetId" = $3 ORDER BY id LIMIT 1`,
      [randomUUID(), queued, target],
    );
    for (const key of [
      null,
      'project.read',
      'project.write',
      'group.read',
      'group.write',
    ]) {
      const permissions = ['target.read', 'asset.read', 'job.read'];
      if (key) permissions.push(key);
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [permissions, role],
      );
      const activity = await read(target, headers).expect(200);
      expect(activity.body.data[0]).toMatchObject({
        id: queued,
        projectId: key ? projectId : null,
        projectName: key ? projectName : null,
        newVulnerabilities: null,
      });
      const overview = await request(app.server)
        .get(`/api/targets/${target}/overview`)
        .set(headers)
        .expect(200);
      expect(overview.body.lastRun).toEqual(activity.body.data[0]);
    }

    for (const key of ['vulnerability.read', 'vulnerability.write']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [['target.read', 'asset.read', 'job.read', key], role],
      );
      const activity = await read(target, headers).expect(200);
      expect(activity.body.data[0]).toMatchObject({
        id: queued,
        projectId: null,
        projectName: null,
        newVulnerabilities: 1,
      });
      const overview = await request(app.server)
        .get(`/api/targets/${target}/overview`)
        .set(headers)
        .expect(200);
      expect(overview.body.lastRun).toEqual(activity.body.data[0]);
    }
  });
});
