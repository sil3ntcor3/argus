import { SummaryReportService } from '@/modules/reports/services/summary-report.service';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Open findings in the attack surface summary report (e2e)', () => {
  let app: TestApp;
  let scope: Awaited<ReturnType<typeof createUserWithWorkspace>>;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    scope = await createUserWithWorkspace(app.server, 'summary-report-open');
  });

  afterAll(async () => {
    if (!app) return;
    try {
      if (scope) {
        await cleanupE2eData(app.dataSource, {
          workspaceIds: [scope.workspace.id],
          userIds: [scope.user.userId],
        });
      }
    } finally {
      await closeTestApp(app.app);
    }
  });

  async function insert(sql: string, values: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values);
    return row.id;
  }

  it('counts expired risk as open without inflating the risk of new targets and ports', async () => {
    const host = randomUUID() + '.example.test';
    const clean = randomUUID() + '.example.test';
    // Match the report's wall clock for timestamp columns without time zones.
    const discoveredAt = new Date();
    const target = await insert(
      'INSERT INTO targets (value, type, "workspaceId", "createdAt") VALUES ($1, $2, $3, $4)',
      [host, 'DOMAIN', scope.workspace.id, discoveredAt],
    );
    await insert('INSERT INTO targets (value, type, "workspaceId", "createdAt") VALUES ($1, $2, $3, $4)', [
      clean, 'DOMAIN', scope.workspace.id, discoveredAt,
    ]);
    const asset = await insert('INSERT INTO assets (value, "targetId") VALUES ($1, $2)', [host, target]);
    await insert('INSERT INTO asset_services (value, port, "assetId", "createdAt") VALUES ($1, 443, $2, $3)', [
      host, asset, discoveredAt,
    ]);
    await insert('INSERT INTO asset_services (value, port, "assetId", "createdAt") VALUES ($1, 8443, $2, $3)', [
      host, asset, discoveredAt,
    ]);
    const makeFinding = (archived = false) => insert(
      'INSERT INTO vulnerabilities (name, severity, "assetId", ports, "isArchived") VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), 'critical', asset, ['443'], archived],
    );
    const expired = await makeFinding();
    const active = await makeFinding();
    const archived = await makeFinding(true);
    await app.dataSource.query(
      `INSERT INTO vulnerability_dismissals ("vulnerabilityId", "userId", reason, "expiresAt")
       VALUES ($1, $4, 'risk_accepted', statement_timestamp() - interval '1 day'),
              ($2, $4, 'risk_accepted', statement_timestamp() + interval '1 day'),
              ($3, $4, 'risk_accepted', statement_timestamp() - interval '1 day')`,
      [expired, active, archived, scope.user.userId],
    );

    const report = await app.app
      .get(SummaryReportService)
      .getSummaryReportData(scope.workspace.id);
    expect(report.weekly.activeVulns).toBe(1);
    expect(report.vulnerabilityByTarget).toEqual([
      expect.objectContaining({ target: host, critical: 1, total: 1 }),
    ]);
    expect(report.newDiscoveries.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ identifier: host, riskLevel: 'low' }),
      expect.objectContaining({ identifier: clean, riskLevel: 'low' }),
    ]));
    expect(report.newDiscoveries.ports).toHaveLength(2);
    expect(report.newDiscoveries.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: host, port: 443, riskLevel: 'low' }),
      expect.objectContaining({ target: host, port: 8443, riskLevel: 'low' }),
    ]));
  });
});
