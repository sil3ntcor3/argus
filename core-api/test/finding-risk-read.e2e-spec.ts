import { randomUUID } from 'node:crypto';
import { ProjectFindingReadService } from '@/modules/projects/project-finding-read.service';
import { VulnerabilityReportService } from '@/modules/reports/services/vulnerability-report.service';
import { VulnerabilityStatus } from '@/modules/vulnerabilities/dto/get-vulnerability.dto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Risk expiry in finding reads (e2e)', () => {
  let app: TestApp;
  let scope: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let target: string;
  let asset: string;
  let expired: string;
  let future: string;
  let indefinite: string;
  let ordinary: string;
  let project: string;
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
    const finding = await insertId(
      `INSERT INTO vulnerabilities (name, severity, "assetId", "isArchived") VALUES ($1, 'critical', $2, $3)`,
      [randomUUID(), asset, archived],
    );
    await app.dataSource.query(
      `INSERT INTO vulnerability_dismissals ("vulnerabilityId", "userId", reason, "expiresAt") VALUES ($1,$2,$3,$4)`,
      [finding, scope.user.userId, reason, expiry],
    );
    return finding;
  }

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
    future = await dismissed('risk_accepted', time(1));
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
        workspaceIds: [scope?.workspace.id].filter(Boolean),
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
    expect(active).not.toHaveProperty('expiresAt');
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
});
