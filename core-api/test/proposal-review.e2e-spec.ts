import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import { VulnerabilityReviewService } from '@/modules/vulnerabilities/vulnerability-review.service';
import { VulnerabilityReportService } from '@/modules/reports/services/vulnerability-report.service';
import { SummaryReportService } from '@/modules/reports/services/summary-report.service';
import { StatisticService } from '@/modules/statistic/statistic.service';

describe('AI finding review (Docker HTTP)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreign: typeof owner;
  let asset: string;
  let secondAsset: string;
  const runs: string[] = [];
  const insert = async (sql: string, args: unknown[] = []) => (await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
  const finding = (status = 'pending_review', assetId = asset, name = 'SQL injection') => insert(`INSERT INTO vulnerabilities (name,fingerprint,"assetId",severity,"reviewStatus","discoveredBy","timesDetected") VALUES ($1,$2,$3,'high',$4,'ai',0)`, [name, randomUUID(), assetId, status]);
  const post = (id: string, action: string, body: object = {}) => request(app.server).post(`/api/vulnerabilities/${id}/review/${action}`).set(owner.headers).send(body);
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'proposal-review');
    foreign = await createUserWithWorkspace(app.server, 'proposal-foreign');
    const target = await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)', ['review.example.test','DOMAIN',owner.workspace.id]);
    asset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', ['review.example.test',target]);
    secondAsset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', ['other.review.example.test',target]);
  });
  afterAll(async () => {
    if (app) await app.dataSource.query('DELETE FROM job_histories WHERE id=ANY($1::uuid[])',[runs]);
    if (app) await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id,foreign?.workspace.id].filter(Boolean), userIds: [owner?.user.userId,foreign?.user.userId].filter(Boolean) });
    await closeTestApp(app?.app);
  });
  it('keeps pending/rejected rows out of all approved views and counts', async () => {
    const pending = await finding(); const rejected = await finding('rejected');
    const approved = await finding('approved');
    for (const status of ['all','open','new']) {
      const r = await request(app.server).get('/api/vulnerabilities').query({ status }).set(owner.headers).expect(200);
      const ids = r.body.data.map((row: { id: string }) => row.id);
      expect(ids).toContain(approved); expect(ids).not.toContain(pending); expect(ids).not.toContain(rejected);
    }
    const pendingView = await request(app.server).get('/api/vulnerabilities').query({ status:'pending_review',discoveredBy:['ai'] }).set(owner.headers).expect(200);
    expect(pendingView.body.data.map((row: { id: string }) => row.id)).toContain(pending);
    const stats = await request(app.server).get('/api/vulnerabilities/statistics').set(owner.headers).expect(200);
    expect(stats.body.pendingReview).toBe(1);
    expect(stats.body.data.find((row: { severity: string }) => row.severity === 'high').count).toBe(1);
  });
  it('approves once, starts the SLA now, records a detection, and returns a conflict for repeat decisions', async () => {
    const serviceId = await finding();
    expect(await app.app.get(VulnerabilityReviewService).approve(serviceId, { severity: 'critical' as never }, owner.user.userId, owner.workspace.id)).toMatchObject({ reviewStatus:'approved' });
    const id = await finding();
    await post(id,'approve',{ severity:'critical',note:'Reproduced locally' }).expect(200,{ id,reviewStatus:'approved',detectionStatus:'new',severity:'critical' });
    await post(id,'reject',{ note:'Late decision' }).expect(409);
    const [row] = await app.dataSource.query('SELECT "dueAt","firstDetectedDate","reviewedAt","timesDetected" FROM vulnerabilities WHERE id=$1',[id]);
    expect(row.dueAt.getTime()).toBeGreaterThan(row.firstDetectedDate.getTime());
    expect(row.timesDetected).toBe(0);
    const events = await app.dataSource.query('SELECT type FROM vulnerability_events WHERE "vulnerabilityId"=$1',[id]);
    expect(events.map((event: { type: string }) => event.type).sort()).toEqual(['approved','detected']);
    const detail = await request(app.server).get(`/api/vulnerabilities/${id}`).set(owner.headers).expect(200);
    expect(detail.body).toMatchObject({ reviewStatus:'approved',discoveredBy:'ai',reviewNote:'Reproduced locally',reviewedByUser:{ id:owner.user.userId } });
    expect(Object.keys(detail.body.reviewedByUser).sort()).toEqual(['id','image','name']);
    expect(detail.body).not.toHaveProperty('reviewedById');
  });
  it('serializes competing approve and reject decisions without duplicated events', async () => {
    const id = await finding();
    const results = await Promise.all([post(id,'approve'),post(id,'reject',{ note:'Not reproducible' })]);
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    const events = await app.dataSource.query(`SELECT type FROM vulnerability_events WHERE "vulnerabilityId"=$1 AND type IN ('approved','rejected')`,[id]);
    expect(events).toHaveLength(1);
  });
  it('requires a nonblank bounded rejection note and ignores foreign IDs', async () => {
    const id = await finding();
    for (const body of [{},{ note:'   ' },{ note:'x'.repeat(5001) }]) await post(id,'reject',body).expect(400);
    await post(id,'approve',{ severity:'invalid' }).expect(400);
    await request(app.server).post(`/api/vulnerabilities/${id}/review/approve`).set(foreign.headers).send({}).expect(404);
    await request(app.server).post(`/api/vulnerabilities/${id}/review/approve`).send({}).expect(401);
    await post(id,'reject',{ note:'  Rejected with retained evidence  ' }).expect(200);
    const r = await request(app.server).get(`/api/vulnerabilities/${id}`).set(owner.headers).expect(200);
    expect(r.body.reviewNote).toBe('Rejected with retained evidence');
  });
  it('deduplicates bulk IDs and skips missing and no-longer-pending IDs', async () => {
    const id = await finding(); const decided = await finding('approved'); const absent = randomUUID();
    const r = await request(app.server).post('/api/vulnerabilities/review/approve').set(owner.headers).send({ ids:[id,id,decided,absent] }).expect(200);
    expect(r.body.reviewed.map((row: { id: string }) => row.id)).toEqual([id]);
    expect(r.body.skipped.map((row: { id: string }) => row.id)).toEqual([decided,absent]);
    const rejected = await finding();
    await request(app.server).post('/api/vulnerabilities/review/reject').set(owner.headers).send({ ids:[rejected],note:'Rejected' }).expect(200);
    await request(app.server).post('/api/vulnerabilities/review/reject').set(owner.headers).send({ ids:[],note:'Rejected' }).expect(400);
  });
  it('ranks at most twenty approved same-asset duplicate candidates deterministically', async () => {
    const id = await finding(); const target = await finding('approved');
    const pending = await finding(); const other = await finding('approved',secondAsset);
    const response = await request(app.server).get(`/api/vulnerabilities/${id}/review/duplicates`).set(owner.headers).expect(200);
    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(target); expect(ids).not.toContain(pending); expect(ids).not.toContain(other);
    expect(response.body.data.length).toBeLessThanOrEqual(20);
    expect(response.body.data.find((row: { id: string }) => row.id === target).reasons).toContain('name');
  });
  it('rejects cross-asset merges and preserves proposal proof, comments and history on a valid merge', async () => {
    const id = await finding(); const target = await finding('approved'); const other = await finding('approved',secondAsset);
    const evidence = { requests:['GET /'],responses:['error'],baseline:'normal' };
    const source = await insert(`INSERT INTO vulnerability_sources ("vulnerabilityId",kind,evidence) VALUES ($1,'ai_agent',$2)`,[id,evidence]);
    await app.dataSource.query(`INSERT INTO vulnerability_events ("vulnerabilityId","workspaceId",type,"toStatus") VALUES ($1,$2,'proposed','pending_review')`,[id,owner.workspace.id]);
    const comment = await request(app.server).post(`/api/vulnerabilities/${id}/comments`).set(owner.headers).send({ content:'Keep this review discussion' }).expect(201);
    await post(id,'merge',{ targetVulnerabilityId:other }).expect(400);
    await post(id,'merge',{ targetVulnerabilityId:id }).expect(400);
    await post(id,'merge',{ targetVulnerabilityId:target }).expect(200,{ targetVulnerabilityId:target,movedSources:1 });
    expect((await app.dataSource.query('SELECT "vulnerabilityId",evidence FROM vulnerability_sources WHERE id=$1',[source]))[0]).toEqual({ vulnerabilityId:target,evidence });
    expect((await app.dataSource.query('SELECT "vulnerabilityId" FROM comments WHERE id=$1',[comment.body.id]))[0]).toEqual({ vulnerabilityId:target });
    const events = await request(app.server).get(`/api/vulnerabilities/${target}/timeline`).set(owner.headers).expect(200);
    expect(events.body.data.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['proposed','merged']));
    expect(JSON.stringify(events.body)).not.toContain('proposalId');
    await request(app.server).get(`/api/vulnerabilities/${id}`).set(owner.headers).expect(404);
  });
  it('excludes unapproved rows from target discovery feeds, weekly charts, project totals and reports', async () => {
    const target = await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)', ['isolated-review.example.test','DOMAIN',owner.workspace.id]);
    const scopedAsset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', ['isolated-review.example.test',target]);
    const pending = await finding('pending_review',scopedAsset,'Pending aggregate sentinel');
    const rejected = await finding('rejected',scopedAsset,'Rejected aggregate sentinel');
    const approved = await finding('approved',scopedAsset,'Approved aggregate sentinel');
    await app.dataSource.query(`UPDATE vulnerabilities SET "createdAt"=now()-interval '1 day',"firstDetectedDate"=now()-interval '1 day' WHERE id=ANY($1::uuid[])`,[[pending,rejected,approved]]);
    const project = (await request(app.server).post('/api/projects').set(owner.headers).send({ name:'Review totals' }).expect(201)).body.id;
    for (const id of [pending,rejected,approved]) await app.dataSource.query('INSERT INTO project_vulnerabilities ("projectId","vulnerabilityId") VALUES ($1,$2)',[project,id]);
    const overview = await request(app.server).get(`/api/targets/${target}/overview`).set(owner.headers).expect(200);
    expect(overview.body.openVulnerabilities.high).toBe(1);
    expect(overview.body.weekly.reduce((sum: number,row: { high: number })=>sum+row.high,0)).toBe(1);
    const changes = await request(app.server).get(`/api/targets/${target}/changes`).query({ kind:'vulnerability' }).set(owner.headers).expect(200);
    expect(changes.body.data.map((row: { id: string })=>row.id)).toEqual([approved]);
    const projectOverview = await request(app.server).get(`/api/projects/${project}/overview`).set(owner.headers).expect(200);
    expect(projectOverview.body.openVulnerabilities.high).toBe(1);
    expect(projectOverview.body.weekly.reduce((sum: number,row: { high: number })=>sum+row.high,0)).toBe(1);
    const report = await app.app.get(VulnerabilityReportService).getVulnerabilityReportData(owner.workspace.id);
    expect(JSON.stringify(report)).not.toContain('Pending aggregate sentinel');
    expect(JSON.stringify(report)).not.toContain('Rejected aggregate sentinel');
    expect(JSON.stringify(report)).toContain('Approved aggregate sentinel');
  });
  it('keeps unapproved archived or dismissed proposals out of resolved report sections',async()=>{
    const target=await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',['resolved-review.example.test','DOMAIN',owner.workspace.id]);
    const scopedAsset=await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)',['resolved-review.example.test',target]);
    const pending=await finding('pending_review',scopedAsset,'Unapproved archive sentinel');
    const rejected=await finding('rejected',scopedAsset,'Unapproved dismissal sentinel');
    const approved=await finding('approved',scopedAsset,'Approved resolved sentinel');
    await app.dataSource.query('UPDATE vulnerabilities SET "isArchived"=true WHERE id=$1',[pending]);
    for (const id of [rejected,approved]) await app.dataSource.query(`INSERT INTO vulnerability_dismissals ("vulnerabilityId","userId",reason,"createdAt") VALUES ($1,$2,'false_positive',now()-interval '1 day')`,[id,owner.user.userId]);
    const report=await app.app.get(SummaryReportService).getSummaryReportData(owner.workspace.id,{ targetIds:[target] });
    expect(report.resolvedFindings.map(row=>row.title)).toEqual(['Approved resolved sentinel']);
    expect(report.weekly.resolvedVulns).toBe(1);
  });
  it('retains metadata-only source attribution when scanner run identities collide during a merge',async()=>{
    const id=await finding(),target=await finding('approved');
    const run=await insert('INSERT INTO job_histories ("jobHistoryName") VALUES ($1)',['Merge collision fixture']);runs.push(run);
    await app.dataSource.query(`INSERT INTO vulnerability_sources ("vulnerabilityId",kind,"jobHistoryId") VALUES ($1,'tool',$2)`,[target,run]);
    await app.dataSource.query(`INSERT INTO vulnerability_sources ("vulnerabilityId",kind,"jobHistoryId","agentName","toolCallIds","createdById") VALUES ($1,'tool',$2,$3,$4,$5)`,[id,run,'Retained attribution',['retained-call'],owner.user.userId]);
    await post(id,'merge',{ targetVulnerabilityId:target }).expect(200,{ targetVulnerabilityId:target,movedSources:1 });
    const sources=await app.dataSource.query(`SELECT "agentName","toolCallIds","createdById" FROM vulnerability_sources WHERE "vulnerabilityId"=$1 AND kind='ai_agent'`,[target]);
    expect(sources).toEqual([{ agentName:'Retained attribution',toolCallIds:['retained-call'],createdById:owner.user.userId }]);
  });
  it('counts an old proposal approved today as a new detection in current reports and trends',async()=>{
    const target=await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',['aged-review.example.test','DOMAIN',owner.workspace.id]);
    const scopedAsset=await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)',['aged-review.example.test',target]);
    const id=await finding('pending_review',scopedAsset,'Aged proposal approved today');
    await app.dataSource.query(`UPDATE vulnerabilities SET "createdAt"=now()-interval '60 days',"firstDetectedDate"=now()-interval '60 days' WHERE id=$1`,[id]);
    await post(id,'approve').expect(200);
    const startDate=new Date(Date.now()-86400_000),endDate=new Date(Date.now()+86400_000);
    const trends=await app.app.get(StatisticService).getDailyVulnerabilityCounts(owner.workspace.id,startDate,endDate,{ targetIds:[target] });
    expect(trends.reduce((sum,row)=>sum+row.count,0)).toBe(1);
    const report=await app.app.get(VulnerabilityReportService).getVulnerabilityReportData(owner.workspace.id,{ startDate,endDate,targetIds:[target] });
    expect(JSON.stringify(report)).toContain('Aged proposal approved today');
    const summary=await app.app.get(SummaryReportService).getSummaryReportData(owner.workspace.id,{ startDate,endDate,targetIds:[target] });
    expect(summary.newFindings.map(row=>row.title)).toEqual(['Aged proposal approved today']);
  });
});
