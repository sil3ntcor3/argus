import { randomUUID } from 'node:crypto';
import { BullMQName, CronSchedule } from '@/common/enums/enum';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Target enrichment and fixed finding activity (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreign: typeof owner;
  let target: string, empty: string, foreignTarget: string, asset: string;
  let role: string;
  let restricted: Record<string, string>;
  let workflow: string, foreignWorkflow: string, tool: string;
  let queue: Queue;
  const schedulers: string[] = [];
  const zeros = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const fixedRows: {
    id: string;
    at: string;
    label: string;
    severity: string;
  }[] = [];
  const timestamp = new Date(Date.now() - 60_000);

  async function insert(table: string, values: Record<string, unknown>) {
    const keys = Object.keys(values);
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO ${table} (${keys.map((k) => '"' + k + '"').join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
      Object.values(values),
    );
    return row.id;
  }
  const makeTarget = (
    workspaceId: string,
    value = randomUUID() + '.example.test',
  ) => insert('targets', { workspaceId, value, type: 'DOMAIN' });
  const makeAsset = (targetId: string) =>
    insert('assets', {
      targetId,
      value: randomUUID() + '.example.test',
      isPrimary: true,
    });
  const finding = (values: Record<string, unknown> = {}) =>
    insert('vulnerabilities', {
      assetId: asset,
      name: randomUUID(),
      severity: 'critical',
      createdAt: new Date(timestamp.getTime() - 86400_000),
      ...values,
    });
  async function run(
    statuses: string[],
    options: {
      completed?: boolean;
      days?: number;
      workflow?: string;
      asset?: string;
    } = {},
  ) {
    const history = await insert('job_histories', {
      workflowId: options.workflow ?? workflow,
      scope: { targetIds: [target] },
      isCompleted: options.completed ?? false,
      createdAt: new Date(Date.now() - (options.days ?? 0) * 86400_000),
    });
    for (const status of statuses)
      await insert('jobs', {
        jobHistoryId: history,
        assetId: options.asset ?? asset,
        toolId: tool,
        category: 'vulnerabilities',
        status,
      });
    return history;
  }
  async function grant(permissions: string[]) {
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [permissions, role],
    );
  }
  const list = (headers = owner.headers, query: Record<string, unknown> = {}) =>
    request(app.server).get('/api/targets').set(headers).query(query);
  const overview = (id = target, headers = owner.headers) =>
    request(app.server).get(`/api/targets/${id}/overview`).set(headers);
  const changes = (
    headers = owner.headers,
    query: Record<string, unknown> = {},
  ) =>
    request(app.server)
      .get(`/api/targets/${target}/changes`)
      .set(headers)
      .query(query);

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'enriched-target-owner');
    foreign = await createUserWithWorkspace(
      app.server,
      'enriched-target-other',
    );
    target = await makeTarget(
      owner.workspace.id,
      'a-' + randomUUID() + '.example.test',
    );
    empty = await makeTarget(
      owner.workspace.id,
      'z-' + randomUUID() + '.example.test',
    );
    foreignTarget = await makeTarget(foreign.workspace.id);
    asset = await makeAsset(target);
    const [{ id: workflowId }] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId"=$1 LIMIT 1',
      [owner.workspace.id],
    );
    const [{ id: foreignWorkflowId }] = await app.dataSource.query<
      { id: string }[]
    >('SELECT id FROM workflows WHERE "workspaceId"=$1 LIMIT 1', [
      foreign.workspace.id,
    ]);
    const [{ id: toolId }] = await app.dataSource.query<{ id: string }[]>(
      "SELECT id FROM tools WHERE name='nuclei'",
    );
    workflow = workflowId;
    foreignWorkflow = foreignWorkflowId;
    tool = toolId;
    const member = await insert('workspace_members', {
      workspaceId: owner.workspace.id,
      userId: foreign.user.userId,
    });
    role = await insert('workspace_permissions', {
      workspaceId: owner.workspace.id,
      name: randomUUID(),
      permissions: ['target.read'],
    });
    await insert('workspace_member_permissions', {
      memberId: member,
      permissionId: role,
    });
    restricted = wsHeaders(foreign.user.cookie, owner.workspace.id);
    queue = app.app.get<Queue>(
      getQueueToken(BullMQName.ASSETS_DISCOVERY_SCHEDULE),
    );

    await finding();
    await finding({ severity: 'high', detectionStatus: 'resurfaced' });
    const expired = await finding({ severity: 'info' });
    await insert('vulnerability_dismissals', {
      vulnerabilityId: expired,
      userId: owner.user.userId,
      reason: 'risk_accepted',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const dismissed = await finding({ severity: 'medium' });
    await insert('vulnerability_dismissals', {
      vulnerabilityId: dismissed,
      userId: owner.user.userId,
      reason: 'accepted',
    });
    await finding({ severity: 'low', isArchived: true });
    await finding({ reviewStatus: 'pending_review' });
    await finding({ reviewStatus: 'rejected' });
    await finding({ assetId: await makeAsset(foreignTarget) });
    for (const [label, days, values] of [
      ['Recent fixed', 1, {}],
      ['Older fixed', 9, {}],
      ['Archived fixed', 2, { isArchived: true }],
      ['Future fixed', -1, {}],
      ['Pending fixed', 1, { reviewStatus: 'pending_review' }],
      ['Rejected fixed', 1, { reviewStatus: 'rejected' }],
      ['Unrecorded fixed', 1, { fixedAt: null }],
    ] as const) {
      const at = new Date(Date.now() - days * 86400_000);
      const id = await finding({
        name: label,
        severity: 'high',
        detectionStatus: 'fixed',
        fixedAt: at,
        ...values,
      });
      if (['Recent fixed', 'Older fixed', 'Archived fixed'].includes(label))
        fixedRows.push({ id, label, at: at.toISOString(), severity: 'high' });
    }
    fixedRows.sort(
      (a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
    );
    await run(['completed', 'skipped', 'cancelled', 'pending', 'in_progress']);
    await run(['pending'], { completed: true });
    await run(['pending'], { days: 8 });
    await run(['failed', 'pending']);
    await run(['pending'], { workflow: foreignWorkflow });
    await run(['pending'], { asset: await makeAsset(foreignTarget) });
  });
  afterAll(async () => {
    if (!app) return;
    try {
      for (const id of schedulers) await queue.removeJobScheduler(id);
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

  it('enriches only the scoped page without changing totals or base rows', async () => {
    const all = await list()
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(all.body.total).toBe(2);
    const row = all.body.data.find((r: { id: string }) => r.id === target);
    expect(row).toMatchObject({
      openVulnerabilities: { ...zeros, critical: 1, high: 1, info: 1 },
      scanProgress: { done: 3, total: 5 },
      nextScanAt: null,
      projects: [],
    });
    expect(row).not.toHaveProperty('jobId');
    const vacant = all.body.data.find((r: { id: string }) => r.id === empty);
    expect(vacant).toMatchObject({
      openVulnerabilities: zeros,
      scanProgress: null,
      projects: [],
    });
    const pages = [];
    for (const page of [1, 2, 3]) {
      const response = await list(owner.headers, { limit: 1, page }).expect(
        200,
      );
      expect(response.body.total).toBe(2);
      pages.push(...response.body.data);
    }
    expect(new Set(pages.map((row: { id: string }) => row.id))).toEqual(
      new Set([target, empty]),
    );
    expect(pages).toHaveLength(2);
    const filtered = await list(owner.headers, {
      value: 'no-matching-target',
    }).expect(200);
    expect(filtered.body).toMatchObject({ total: 0, data: [] });
  });

  it.each(['read', 'write'])(
    'independently redacts enrichment with effective %s access',
    async (mode) => {
      for (const domain of ['vulnerability', 'job', 'project', null]) {
        await grant(['target.read', ...(domain ? [`${domain}.${mode}`] : [])]);
        const response = await list(restricted)
          .expect(200)
          .expect('Cache-Control', 'private, no-store');
        const row = response.body.data.find(
          (r: { id: string }) => r.id === target,
        );
        expect(row.openVulnerabilities).toEqual(
          domain === 'vulnerability'
            ? { ...zeros, critical: 1, high: 1, info: 1 }
            : null,
        );
        expect(row.scanProgress).toEqual(
          domain === 'job' ? { done: 3, total: 5 } : null,
        );
        expect(row.projects).toEqual(domain === 'project' ? [] : null);
        expect(JSON.stringify(response.body)).not.toContain(foreignTarget);
      }
    },
  );

  it('uses at most six owned active project references with deterministic counts and ties', async () => {
    const expected = [];
    const second = await makeAsset(target);
    for (const name of [
      'Zulu',
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
      'Foxtrot',
    ]) {
      const hexColor = name === 'Zulu' ? '#123456' : null;
      const id = await insert('projects', {
        workspaceId: owner.workspace.id,
        name,
        hexColor,
      });
      for (const assetId of name === 'Zulu' ? [asset, second] : [asset])
        await insert('project_assets', { projectId: id, assetId });
      expected.push({ id, name, hexColor, assets: name === 'Zulu' ? 2 : 1 });
    }
    for (const [workspaceId, archivedAt] of [
      [foreign.workspace.id, null],
      [owner.workspace.id, new Date()],
    ] as const) {
      const project = await insert('projects', {
        workspaceId,
        name: randomUUID(),
        archivedAt,
      });
      await insert('project_assets', { projectId: project, assetId: asset });
    }
    const response = await list().expect(200);
    expect(
      response.body.data.find((r: { id: string }) => r.id === target).projects,
    ).toEqual(expected.slice(0, 6));
  });

  it('reads the actual saved firing time and rejects stale scheduler identities', async () => {
    const key = 'target-enrichment-' + randomUUID();
    schedulers.push(key);
    await queue.upsertJobScheduler(
      key,
      { pattern: CronSchedule.DAILY, tz: 'UTC' },
      {
        name: target,
        data: { targetId: target, workspaceId: owner.workspace.id },
      },
    );
    await app.dataSource.query(
      'UPDATE targets SET "jobId"=$1,"scanSchedule"=$2 WHERE id=$3',
      [key, CronSchedule.DAILY, target],
    );
    let response = await list().expect(200);
    const scheduler = await queue.getJobScheduler(key);
    expect(scheduler?.next).toBeGreaterThan(Date.now());
    const expected = new Date(scheduler!.next!).toISOString();
    expect(
      response.body.data.find((r: { id: string }) => r.id === target)
        .nextScanAt,
    ).toBe(expected);
    expect((await overview().expect(200)).body.nextScanAt).toBe(expected);
    for (const cron of [CronSchedule.WEEKLY, CronSchedule.DISABLED]) {
      await app.dataSource.query(
        'UPDATE targets SET "scanSchedule"=$1 WHERE id=$2',
        [cron, target],
      );
      response = await list().expect(200);
      expect(
        response.body.data.find((r: { id: string }) => r.id === target)
          .nextScanAt,
      ).toBeNull();
    }
    await app.dataSource.query('UPDATE targets SET "jobId"=NULL WHERE id=$1', [
      target,
    ]);
  });

  it('counts only recent recorded approved fixes and redacts them independently', async () => {
    expect((await overview().expect(200)).body.fixedVulnerabilities).toBe(2);
    expect((await overview(empty).expect(200)).body.fixedVulnerabilities).toBe(
      0,
    );
    await grant(['target.read', 'asset.read']);
    expect(
      (await overview(target, restricted).expect(200)).body
        .fixedVulnerabilities,
    ).toBeNull();
    await grant(['target.read', 'asset.read', 'vulnerability.write']);
    expect(
      (await overview(target, restricted).expect(200)).body
        .fixedVulnerabilities,
    ).toBe(2);
  });

  it('returns original discoveries and distinct fixed entries with absolute timestamps and stable pagination', async () => {
    const fixed = await changes(owner.headers, { kind: 'fixed' }).expect(200);
    expect(fixed.body.total).toBe(3);
    expect(fixed.body.data).toEqual(
      fixedRows.map((row) => ({
        ...row,
        kind: 'fixed',
        assetValue: expect.any(String),
      })),
    );
    const mixed = await changes(owner.headers, { limit: 100 }).expect(200);
    for (const row of fixedRows) {
      expect(mixed.body.data).toContainEqual(
        expect.objectContaining({ id: row.id, kind: 'fixed', at: row.at }),
      );
      expect(mixed.body.data).toContainEqual(
        expect.objectContaining({
          id: row.id,
          kind: 'vulnerability',
          at: new Date(timestamp.getTime() - 86400_000).toISOString(),
        }),
      );
    }
    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      const response = await changes(owner.headers, {
        kind: 'fixed',
        limit: 1,
        page,
      }).expect(200);
      expect(response.body.total).toBe(3);
      pages.push(...response.body.data);
    }
    expect(pages).toEqual(fixed.body.data);
    await changes(owner.headers, { kind: 'unknown' }).expect(400);
  });

  it('denies explicit fixed reads without access and keeps mixed results free of findings', async () => {
    await grant(['target.read', 'asset.read']);
    await changes(restricted, { kind: 'fixed' }).expect(403);
    const response = await changes(restricted).expect(200);
    expect(response.body.data).toEqual([]);
    await request(app.server)
      .get(`/api/targets/${foreignTarget}/changes`)
      .set(owner.headers)
      .query({ kind: 'fixed' })
      .expect(404);
    await request(app.server).get('/api/targets').expect(401);
    await grant(['asset.read']);
    await list(restricted).expect(403);
  });

  it('preserves a recorded first-detection instant instead of applying a legacy timezone conversion', async () => {
    const instant = new Date('2026-11-01T06:30:00.000Z');
    const id = await finding({ firstDetectedDate: instant });
    const response = await changes(owner.headers, {
      kind: 'vulnerability',
      limit: 100,
    }).expect(200);
    expect(response.body.data.find((r: { id: string }) => r.id === id).at).toBe(
      instant.toISOString(),
    );
  });

  it('uses 168 elapsed hours across DST even when Postgres runs in America/Chicago', async () => {
    const id = await makeTarget(owner.workspace.id);
    const assetId = await makeAsset(id);
    for (const fixedAt of ['2026-10-31T17:30:00Z', '2026-10-31T18:30:00Z'])
      await finding({
        assetId,
        detectionStatus: 'fixed',
        fixedAt: new Date(fixedAt),
      });
    const runner = app.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query("SET LOCAL TIME ZONE 'America/Chicago'");
    const original = app.dataSource.query.bind(app.dataSource);
    const query = jest
      .spyOn(app.dataSource, 'query')
      .mockImplementation((sql, parameters, activeRunner) => {
        // Freeze only this read's clock; execute the actual production SQL on
        // a real timezone-configured connection, retaining all other predicates.
        if (parameters?.[0] === id && sql.includes("'fixedVulnerabilities'"))
          return original(
            sql.replaceAll(
              'statement_timestamp()',
              "'2026-11-07T18:00:00Z'::timestamptz",
            ),
            parameters,
            runner,
          ) as Promise<unknown>;
        return original(sql, parameters, activeRunner) as Promise<unknown>;
      });
    try {
      expect((await overview(id).expect(200)).body.fixedVulnerabilities).toBe(
        1,
      );
    } finally {
      query.mockRestore();
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
