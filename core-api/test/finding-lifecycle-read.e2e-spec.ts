import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import * as request from 'supertest';
import { randomUUID } from 'node:crypto';
import { VulnerabilityReportService } from '@/modules/reports/services/vulnerability-report.service';

describe('Finding lifecycle reads (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let reader: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let assetId: string;
  let runId: string;
  let foreignRun: string;
  const insert = async (sql: string, values: unknown[]) => {
    const [{ id }] = await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values);
    return id;
  };
  const seed = (status: string, severity = 'high') => insert(
    `INSERT INTO vulnerabilities(name,fingerprint,"assetId",severity,"detectionStatus","timesDetected",
      "resurfacedCount","firstDetectedDate","fixedAt") VALUES($1,$2,$3,$4,$5,4,1,
      statement_timestamp()-interval '10 days',CASE WHEN $5::varchar='fixed' THEN statement_timestamp()-interval '1 day' END)`,
    [randomUUID(), randomUUID(), assetId, severity, status],
  );
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'lifecycle-read');
    reader = await createUserWithWorkspace(app.server, 'lifecycle-read-limited');
    const target = await insert(`INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2)`,
      ['lifecycle-read.example.test', owner.workspace.id]);
    assetId = await insert(`INSERT INTO assets(value,"targetId") VALUES($1,$2)`, ['lifecycle-read.example.test', target]);
    const workflow = async (workspace: string) => insert(
      `INSERT INTO workflows(name,content,"filePath","workspaceId") VALUES($1,'{}',$1,$2)`, [randomUUID(), workspace]);
    runId = await insert('INSERT INTO job_histories("workflowId") VALUES($1)', [await workflow(owner.workspace.id)]);
    foreignRun = await insert('INSERT INTO job_histories("workflowId") VALUES($1)', [await workflow(reader.workspace.id)]);
    const member = await insert('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)',
      [owner.workspace.id, reader.user.userId]);
    const role = await insert('INSERT INTO workspace_permissions("workspaceId",name,permissions) VALUES($1,$2,$3)',
      [owner.workspace.id, randomUUID(), ['workspace.read', 'vulnerability.read']]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)', [member, role]);
  });
  beforeEach(async () => {
    await app.dataSource.query('DELETE FROM vulnerabilities WHERE "assetId"=$1', [assetId]);
  });
  afterAll(async () => {
    if (app) await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner, reader].filter(Boolean).map(value => value.workspace.id),
      userIds: [owner, reader].filter(Boolean).map(value => value.user.userId),
    });
    await closeTestApp(app?.app);
  });

  it('projects lifecycle fields with safe actors and scoped job-reader-only run references', async () => {
    const id = await seed('active');
    await app.dataSource.query(`UPDATE vulnerabilities SET "jobHistoryId"=$2,"lastSeenJobHistoryId"=$2,
      "fixedByJobHistoryId"=$3,"fixClaimedById"=$4,"fixClaimedAt"=statement_timestamp(),
      "dueAt"=statement_timestamp()+interval '1 day' WHERE id=$1`, [id, runId, foreignRun, owner.user.userId]);
    const response = await request(app.server).get(`/api/vulnerabilities/${id}`).set(owner.headers).expect(200);
    expect(response.body).toMatchObject({ detectionStatus: 'active', timesDetected: 4, resurfacedCount: 1,
      lastSeenJobHistoryId: runId, fixedByJobHistoryId: null,
      fixClaimedAt: expect.any(String), dueAt: expect.any(String),
      fixClaimedByUser: { id: owner.user.userId, image: null, name: expect.any(String) } });
    expect(Object.keys(response.body.fixClaimedByUser).sort()).toEqual(['id', 'image', 'name']);
    const limited = await request(app.server).get(`/api/vulnerabilities/${id}`).set(reader.headers)
      .set('X-Workspace-Id', owner.workspace.id).expect(200);
    expect(limited.body).toMatchObject({ lastSeenJobHistoryId: null, fixedByJobHistoryId: null });
    expect(limited.body).not.toHaveProperty('jobHistoryId');
    expect(limited.body).not.toHaveProperty('jobHistory');
    for (const body of [response.body, limited.body]) for (const privateKey of
      ['scanScopeKey', 'lastScannerObservedAt', 'missedScans', 'fixClaimedById', 'fixClaimedBy']) {
      expect(body).not.toHaveProperty(privateKey);
    }
  });

  it('keeps open, fixed, dismissed and overdue lists and severity totals consistent', async () => {
    const active = await seed('active');
    await app.dataSource.query(`UPDATE vulnerabilities SET "dueAt"=statement_timestamp()-interval '1 day' WHERE id=$1`, [active]);
    await seed('fixed');
    await seed('new');
    const dismissed = await seed('active');
    await insert(`INSERT INTO vulnerability_dismissals("vulnerabilityId","userId",reason)
      VALUES($1,$2,'wont_fix')`, [dismissed, owner.user.userId]);
    for (const [query, count] of [['', 2], ['?status=fixed', 1], ['?status=active', 1],
      ['?status=new', 1], ['?status=dismissed', 1], ['?overdue=true', 1], ['?status=all', 4]] as const) {
      const result = await request(app.server).get('/api/vulnerabilities' + query).set(owner.headers).expect(200);
      expect(result.body.total).toBe(count);
    }
    const stats = await request(app.server).get('/api/vulnerabilities/statistics').set(owner.headers).expect(200);
    expect(stats.body).toMatchObject({ byDetectionStatus: { new: 1, active: 1, resurfaced: 0, fixed: 1 },
      overdue: 1, fixedLast30Days: 1, newLast7Days: 0 });
    expect(stats.body.data.find((row: { severity: string }) => row.severity === 'high').count).toBe(2);
    expect(stats.body.mttr).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'high', count: 1, days: expect.any(Number) }),
    ]));
  });

  it('recomputes open SLA deadlines from saved policy while retaining explicit no-SLA severities', async () => {
    const high = await seed('new');
    const info = await seed('new', 'info');
    await request(app.server).put('/api/vulnerabilities/settings').set(owner.headers)
      .send({ slaDays: { high: 2, info: null } }).expect(200);
    const result = await request(app.server).get(`/api/vulnerabilities/${high}`).set(owner.headers).expect(200);
    expect(new Date(result.body.dueAt).getTime() - new Date(result.body.firstDetectedDate).getTime()).toBe(2 * 86_400_000);
    const informational = await request(app.server).get(`/api/vulnerabilities/${info}`).set(owner.headers).expect(200);
    expect(informational.body.dueAt).toBeNull();
    const policy = await request(app.server).get('/api/vulnerabilities/settings').set(owner.headers).expect(200);
    expect(policy.body.slaDays).toEqual({ critical: 7, high: 2, medium: 90, low: 120, info: null });
  });

  it('excludes fixed findings consistently from target, project and report open totals', async () => {
    const active = await seed('active', 'critical');
    const fixed = await seed('fixed', 'critical');
    const [{ targetId }] = await app.dataSource.query<{ targetId: string }[]>(
      'SELECT "targetId" FROM assets WHERE id=$1', [assetId]);
    const project = await insert('INSERT INTO projects(name,"workspaceId") VALUES($1,$2)',
      [randomUUID(), owner.workspace.id]);
    await app.dataSource.query(`INSERT INTO project_vulnerabilities("projectId","vulnerabilityId")
      SELECT $1,unnest($2::uuid[])`, [project, [active, fixed]]);
    const target = await request(app.server).get(`/api/targets/${targetId}/overview`).set(owner.headers).expect(200);
    expect(target.body.openVulnerabilities.critical).toBe(1);
    const overview = await request(app.server).get(`/api/projects/${project}/overview`).set(owner.headers).expect(200);
    expect(overview.body.openVulnerabilities.critical).toBe(1);
    const findings = await request(app.server).get(`/api/projects/${project}/vulnerabilities?status=open`).set(owner.headers).expect(200);
    expect(findings.body.data.map((row: { id: string }) => row.id)).toEqual([active]);
    const report = await app.app.get(VulnerabilityReportService).getVulnerabilityReportData(owner.workspace.id, { targetIds: [targetId] });
    expect(report.summary.activeCount).toBe(1);
    expect(report.allVulnerabilities.map(row => row.id)).toEqual([active]);
    const fixedFindings = await request(app.server).get(`/api/projects/${project}/vulnerabilities?status=fixed`).set(owner.headers).expect(200);
    expect(fixedFindings.body.data.map((row: { id: string }) => row.id)).toEqual([fixed]);
    expect(fixedFindings.body.data[0].status).toBe('fixed');
  });

  it.each(['maybe', '1', 'null'])('rejects invalid overdue filter %s', async overdue => {
    await request(app.server).get('/api/vulnerabilities').query({ overdue }).set(owner.headers).expect(400);
  });
});
