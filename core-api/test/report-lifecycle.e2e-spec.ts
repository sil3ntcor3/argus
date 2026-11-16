import { SummaryReportService } from '@/modules/reports/services/summary-report.service';
import { VulnerabilityReportService } from '@/modules/reports/services/vulnerability-report.service';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Lifecycle-aware reports (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let target: string, asset: string, foreignAsset: string;
  const q = (sql: string, args: unknown[] = []) =>
    app.dataSource.query<{ id: string }[]>(sql, args);
  const insert = async (sql: string, args: unknown[]) =>
    (await q(sql + ' RETURNING id', args))[0].id;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  async function targetAsset(workspaceId: string) {
    const id = await insert(
      'INSERT INTO targets(value,type,"workspaceId") VALUES($1,\'DOMAIN\',$2)',
      [randomUUID() + '.example.test', workspaceId],
    );
    return {
      target: id,
      asset: await insert(
        'INSERT INTO assets(value,"targetId") VALUES($1,$2)',
        [randomUUID() + '.example.test', id],
      ),
    };
  }
  async function finding(
    name: string,
    options: {
      state?: string;
      review?: string;
      archived?: boolean;
      fixedAt?: Date | null;
      updatedAt?: Date;
      assetId?: string;
    } = {},
  ) {
    return insert(
      `INSERT INTO vulnerabilities(name,fingerprint,severity,"assetId","detectionStatus","reviewStatus","isArchived","fixedAt","createdAt","firstDetectedDate","updatedAt")
      VALUES($1,$2,'critical',$3,$4,$5,$6,$7,$8,$10,$9)`,
      [
        name,
        randomUUID(),
        options.assetId ?? asset,
        options.state ?? 'new',
        options.review ?? 'approved',
        options.archived ?? false,
        options.fixedAt ?? null,
        new Date('2019-01-01T12:00:00Z'),
        options.updatedAt ?? new Date(),
        new Date('2019-01-01T12:00:00Z'),
      ],
    );
  }
  async function dismiss(
    id: string,
    reason = 'wont_fix',
    expiresAt: Date | null = null,
    at = new Date(),
  ) {
    await q(
      'INSERT INTO vulnerability_dismissals("vulnerabilityId","userId",reason,"expiresAt","createdAt") VALUES($1,$2,$3,$4,$5)',
      [id, owner.user.userId, reason, expiresAt, at],
    );
  }
  const summary = (options?: {
    startDate?: Date;
    endDate?: Date;
    targetIds?: string[];
  }) =>
    app.app
      .get(SummaryReportService)
      .getSummaryReportData(owner.workspace.id, options);

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'report-lifecycle-owner');
    other = await createUserWithWorkspace(app.server, 'report-lifecycle-other');
  });
  beforeEach(async () => {
    await q('DELETE FROM targets WHERE "workspaceId"=ANY($1::uuid[])', [
      [owner.workspace.id, other.workspace.id],
    ]);
    ({ target, asset } = await targetAsset(owner.workspace.id));
    foreignAsset = (await targetAsset(other.workspace.id)).asset;
  });
  afterAll(async () => {
    try {
      if (app)
        await cleanupE2eData(app.dataSource, {
          workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
            Boolean,
          ),
          userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
        });
    } finally {
      await closeTestApp(app?.app);
    }
  });

  it('counts and lists approved scan fixes without archiving the finding', async () => {
    await finding('Scan fixed', { state: 'fixed', fixedAt: new Date() });
    await finding('Pending fix', {
      state: 'fixed',
      review: 'pending_review',
      fixedAt: ago(1),
    });
    await finding('Rejected fix', {
      state: 'fixed',
      review: 'rejected',
      fixedAt: ago(1),
    });
    await finding('Foreign fix', {
      state: 'fixed',
      fixedAt: ago(1),
      assetId: foreignAsset,
    });
    await dismiss(
      await finding('Expired risk is open'),
      'risk_accepted',
      ago(60),
    );
    const report = await summary();
    expect(report.weekly.resolvedVulns).toBe(1);
    expect(report.monthly.resolvedVulns).toBe(1);
    expect(report.resolvedFindings.map((row) => row.title)).toEqual([
      'Scan fixed',
    ]);
    expect(report.weekly.activeVulns).toBe(1);
  });

  it('excludes fixed findings from Vulnerability report active and dismissed totals', async () => {
    await finding('Open');
    await dismiss(
      await finding('Active acceptance'),
      'risk_accepted',
      new Date(Date.now() + 86_400_000),
    );
    await dismiss(
      await finding('Expired acceptance'),
      'risk_accepted',
      ago(60),
    );
    await finding('Fixed', { state: 'fixed', fixedAt: ago(1) });
    await dismiss(
      await finding('Fixed and dismissed', { state: 'fixed', fixedAt: ago(1) }),
    );
    await finding('Legacy archived', { archived: true });
    await finding('Pending', { review: 'pending_review' });
    await finding('Rejected', { review: 'rejected' });
    const report = await app.app
      .get(VulnerabilityReportService)
      .getVulnerabilityReportData(owner.workspace.id);
    expect(report.summary).toMatchObject({
      totalVulnerabilities: 3,
      activeCount: 2,
      dismissedCount: 1,
      criticalCount: 2,
    });
    expect(report.allVulnerabilities.map((row) => row.name).sort()).toEqual([
      'Expired acceptance',
      'Open',
    ]);
  });

  it('deduplicates fixes and active dismissals, retaining legacy archives and excluding expired risk', async () => {
    await dismiss(await finding('Both', { state: 'fixed', fixedAt: ago(1) }));
    await dismiss(await finding('Dismissed'));
    await dismiss(
      await finding('Accepted'),
      'risk_accepted',
      new Date(Date.now() + 86_400_000),
    );
    await finding('Legacy archived', { archived: true });
    await dismiss(await finding('Expired'), 'risk_accepted', ago(60));
    await dismiss(
      await finding('Pending dismissal', { review: 'pending_review' }),
    );
    const report = await summary();
    expect(report.weekly.resolvedVulns).toBe(4);
    expect(report.resolvedFindings.map((row) => row.title).sort()).toEqual([
      'Accepted',
      'Both',
      'Dismissed',
      'Legacy archived',
    ]);
  });

  it('filters fixedAt rather than later edits, preserving legacy timestamps and selected targets', async () => {
    const inside = new Date('2020-05-15T12:00:00Z'),
      outside = new Date('2020-04-15T12:00:00Z');
    await finding('Fixed inside', {
      state: 'fixed',
      fixedAt: inside,
      updatedAt: outside,
    });
    await finding('Fixed outside', {
      state: 'fixed',
      fixedAt: outside,
      updatedAt: inside,
    });
    await finding('Legacy inside', { archived: true, updatedAt: inside });
    await finding('Other target', {
      state: 'fixed',
      fixedAt: inside,
      assetId: (await targetAsset(owner.workspace.id)).asset,
    });
    const report = await summary({
      startDate: new Date('2020-05-01T00:00:00Z'),
      endDate: new Date('2020-05-31T23:59:59Z'),
      targetIds: [target],
    });
    expect(report.resolvedFindings.map((row) => row.title).sort()).toEqual([
      'Fixed inside',
      'Legacy inside',
    ]);
    expect(
      report.resolvedFindings.every((row) => row.resolved === '15/05/2020'),
    ).toBe(true);
  });

  it('orders the combined resolved list before applying the row limit', async () => {
    for (let i = 0; i < 10; i++)
      await dismiss(
        await finding('Older dismissal ' + i),
        'wont_fix',
        null,
        ago(10 + i),
      );
    await finding('Newest fix', {
      state: 'fixed',
      fixedAt: ago(1),
      updatedAt: ago(60),
    });
    const report = await summary();
    expect(report.resolvedFindings).toHaveLength(10);
    expect(report.resolvedFindings[0].title).toBe('Newest fix');
  });

  it('preserves local legacy timestamps at the start of a date filter', async () => {
    const at = new Date(2020, 4, 1, 0, 30);
    await finding('Boundary archive', { archived: true, updatedAt: at });
    await finding('Boundary fix', { state: 'fixed', fixedAt: at });
    const report = await summary({
      startDate: new Date(2020, 4, 1, 0, 0),
      endDate: new Date(2020, 4, 1, 1, 0),
    });
    expect(report.resolvedFindings.map((row) => row.title).sort()).toEqual([
      'Boundary archive',
      'Boundary fix',
    ]);
  });

  it('keeps the matching closure date when only one of two resolutions is in the selected period', async () => {
    const inside = new Date('2020-05-15T12:00:00Z');
    await dismiss(
      await finding('Earlier dismissal', { state: 'fixed', fixedAt: ago(1) }),
      'wont_fix',
      null,
      inside,
    );
    const report = await summary({
      startDate: new Date('2020-05-01T00:00:00Z'),
      endDate: new Date('2020-05-31T23:59:59Z'),
    });
    expect(report.resolvedFindings).toEqual([
      expect.objectContaining({
        title: 'Earlier dismissal',
        resolved: expect.stringContaining('2020'),
      }),
    ]);
  });
});
