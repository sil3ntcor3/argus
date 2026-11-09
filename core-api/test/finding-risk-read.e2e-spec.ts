import { randomUUID } from 'node:crypto';
import { ProjectFindingReadService } from '@/modules/projects/project-finding-read.service';
import { VulnerabilityReportService } from '@/modules/reports/services/vulnerability-report.service';
import { VulnerabilityStatus } from '@/modules/vulnerabilities/dto/get-vulnerability.dto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Timed finding risk acceptance (e2e)', () => {
  let app: TestApp;
  let scope: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let target: string;
  let asset: string;
  let expired: string;
  let future: string;
  let futureAt: Date;
  let indefinite: string;
  let ordinary: string;
  let project: string;
  let foreignWorkspace: string | undefined;
  const time = (offset: number) => new Date(Date.now() + offset * 86_400_000);

  async function insertId(sql: string, params: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `${sql} RETURNING id`,
      params,
    );
    return row.id;
  }

  async function dismissed(
    reason: string,
    expiry: Date | null,
    archived = false,
  ) {
    const finding = await makeFinding(asset, archived);
    await app.dataSource.query(
      `INSERT INTO vulnerability_dismissals ("vulnerabilityId", "userId", reason, "expiresAt") VALUES ($1,$2,$3,$4)`,
      [finding, scope.user.userId, reason, expiry],
    );
    return finding;
  }

  const makeFinding = (assetId = asset, archived = false) =>
    insertId(
      `INSERT INTO vulnerabilities (name, severity, "assetId", "isArchived") VALUES ($1, 'critical', $2, $3)`,
      [randomUUID(), assetId, archived],
    );
  const submit = (ids: string[], reason: string, expiresAt?: unknown) =>
    request(app.server)
      .post('/api/vulnerabilities/dismiss')
      .set(scope.headers)
      .send({ ids, reason, expiresAt });

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    scope = await createUserWithWorkspace(app.server, 'risk-expiry-reads');
    const host = `${randomUUID()}.example.test`;
    target = await insertId(
      `INSERT INTO targets (value,type,"workspaceId") VALUES ($1,'DOMAIN',$2)`,
      [host, scope.workspace.id],
    );
    asset = await insertId(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      [host, target],
    );
    expired = await dismissed('risk_accepted', time(-1));
    futureAt = time(1);
    future = await dismissed('risk_accepted', futureAt);
    indefinite = await dismissed('risk_accepted', null);
    ordinary = await dismissed('wont_fix', time(-1));
    const archived = await dismissed('risk_accepted', time(-1), true);
    project = await insertId(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      ['Risk expiry project', scope.workspace.id],
    );
    await app.dataSource.query(
      `INSERT INTO project_vulnerabilities ("projectId", "vulnerabilityId") SELECT $1, unnest($2::uuid[])`,
      [project, [expired, future, indefinite, ordinary, archived]],
    );
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [scope?.workspace.id, foreignWorkspace].filter(Boolean),
        userIds: [scope?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  const list = (status: string) =>
    request(app.server)
      .get(`/api/vulnerabilities?targetId=${target}&status=${status}`)
      .set(scope.headers)
      .expect(200);
  const detail = (id: string) =>
    request(app.server)
      .get(`/api/vulnerabilities/${id}`)
      .set(scope.headers)
      .expect(200);
  const ids = (body: { data: { id: string }[] }) =>
    body.data.map((row) => row.id).sort();

  it('moves due risks from dismissed to open before the cleanup runs', async () => {
    expect(ids((await list('open')).body)).toEqual([expired]);
    expect(ids((await list('dismissed')).body)).toEqual(
      [future, indefinite, ordinary].sort(),
    );
    expect((await detail(expired)).body.vulnerabilityDismissal).toBeNull();
    const active = (await detail(future)).body.vulnerabilityDismissal;
    expect(active.reason).toBe('risk_accepted');
    expect(active.expiresAt).toBe(futureAt.toISOString());
    const [row] = await app.dataSource.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM vulnerability_dismissals WHERE "vulnerabilityId"=$1`,
      [expired],
    );
    expect(row.count).toBe(1);
  });

  it('uses the same open status in finding and target totals', async () => {
    const stats = await request(app.server)
      .get(`/api/vulnerabilities/statistics?targetIds=${target}`)
      .set(scope.headers)
      .expect(200);
    expect(stats.body.data).toContainEqual({ severity: 'critical', count: 1 });
    const summary = await request(app.server)
      .get('/api/targets/summary')
      .set(scope.headers)
      .expect(200);
    expect(summary.body.withCritical).toBe(1);
    expect(summary.body.openVulnerabilities.critical).toBe(1);
  });

  it('agrees with project finding filters and report dismissal counts', async () => {
    const projects = app.app.get(ProjectFindingReadService);
    const query = { page: 1, limit: 10 };
    const open = await projects.list(project, scope.workspace.id, {
      ...query,
      status: VulnerabilityStatus.OPEN,
    });
    const dismissed = await projects.list(project, scope.workspace.id, {
      ...query,
      status: VulnerabilityStatus.DISMISSED,
    });
    expect(ids(open)).toEqual([expired]);
    expect(ids(dismissed)).toEqual([future, indefinite, ordinary].sort());
    const report = await app.app
      .get(VulnerabilityReportService)
      .getVulnerabilityReportData(scope.workspace.id, { targetIds: [target] });
    expect(report.summary.dismissedCount).toBe(3);
  });

  it('requires a bounded future timestamp with timezone only for risk acceptance', async () => {
    const id = await makeFinding();
    for (const invalid of [
      undefined,
      null,
      time(-1).toISOString(),
      time(181).toISOString(),
      time(1).toISOString().slice(0, -1),
    ]) {
      await submit([id], 'risk_accepted', invalid).expect(400);
    }
    await submit([id], 'wont_fix', time(1).toISOString()).expect(400);
    await submit([id], 'wont_fix', null).expect(400);
    expect((await detail(id)).body.vulnerabilityDismissal).toBeNull();
  });

  it('returns the expiry only for timed risks and rejects foreign IDs atomically', async () => {
    const id = await makeFinding();
    foreignWorkspace = await insertId(
      'INSERT INTO workspaces (name) VALUES ($1)',
      [randomUUID()],
    );
    const outside = await insertId(
      `WITH t AS (INSERT INTO targets (value,type,"workspaceId") VALUES ($1,'DOMAIN',$2) RETURNING id),
       a AS (INSERT INTO assets (value,"targetId") SELECT $1,id FROM t RETURNING id)
       INSERT INTO vulnerabilities (name,severity,"assetId") SELECT $1,'critical',id FROM a`,
      [randomUUID(), foreignWorkspace],
    );
    const expiresAt = time(7).toISOString();
    await submit([id, outside], 'risk_accepted', expiresAt).expect(404);
    expect((await detail(id)).body.vulnerabilityDismissal).toBeNull();
    const risk = await submit(
      [id],
      'risk_accepted',
      expiresAt.replace('Z', '+00:00'),
    ).expect(201);
    expect(risk.body[0]).toMatchObject({
      vulnerabilityId: id,
      reason: 'risk_accepted',
      expiresAt,
    });
    expect((await detail(id)).body.vulnerabilityDismissal.expiresAt).toBe(
      expiresAt,
    );
    const legacy = await makeFinding();
    const unchanged = await submit([legacy], 'wont_fix').expect(201);
    expect(unchanged.body[0]).not.toHaveProperty('expiresAt');
    expect(
      (await detail(legacy)).body.vulnerabilityDismissal,
    ).not.toHaveProperty('expiresAt');
  });

  it('replaces the expired row and records its history once across concurrent requests', async () => {
    const expiresAt = time(1).toISOString();
    const results = await Promise.all([
      submit([expired], 'risk_accepted', expiresAt),
      submit([expired], 'risk_accepted', expiresAt),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 400,
    ]);
    expect((await detail(expired)).body.vulnerabilityDismissal.expiresAt).toBe(
      expiresAt,
    );
    const events = await app.dataSource.query<
      { workspaceId: string; type: string; data: unknown }[]
    >(
      `SELECT "workspaceId", type, data FROM vulnerability_events WHERE "vulnerabilityId"=$1`,
      [expired],
    );
    expect(events).toEqual([
      {
        workspaceId: scope.workspace.id,
        type: 'risk_expired',
        data: expect.objectContaining({ acceptedById: scope.user.userId }),
      },
    ]);
  });
});
