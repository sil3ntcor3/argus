import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { VulnerabilityProposalService, proposalFingerprint } from '@/modules/vulnerabilities/vulnerability-proposal.service';
import { setTimeout as delay } from 'node:timers/promises';
import { Severity } from '@/common/enums/enum';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Finding proposals (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let service: VulnerabilityProposalService;
  let asset: string; let outside: string; let conversation: string; let project: string;
  const runs: string[] = [];
  const evidence = { requests:['GET /query?q=test'],responses:['500 query error'],baseline:'200 for safe input' };
  const input = (name = 'SQL injection proof') => ({ assetId:asset,name,severity:Severity.HIGH,evidence });
  const context = () => ({ workspaceId:owner.workspace.id,userId:owner.user.userId,conversationId:conversation,agentName:'pentest' });
  const insert = async (sql: string, args: unknown[]) => (await app.dataSource.query<{ id: string }[]>(sql+' RETURNING id',args))[0].id;
  beforeAll(async () => {
    app = await createTestApp(); service = app.app.get(VulnerabilityProposalService);
    owner = await createUserWithWorkspace(app.server,'proposal-tool'); other = await createUserWithWorkspace(app.server,'proposal-other');
    const target = await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',['proposal.example.test','DOMAIN',owner.workspace.id]);
    asset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)',['proposal.example.test',target]);
    outside = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)',['outside.example.test',target]);
    project = (await request(app.server).post('/api/projects').set(owner.headers).send({ name:'Proposal scope' }).expect(201)).body.id;
    await app.dataSource.query('INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',[project,asset]);
    conversation = randomUUID();
    await app.dataSource.query('INSERT INTO agent_conversations (id,"workspaceId","createdBy","llmConfigId","projectId") VALUES ($1,$2,$3,$4,$5)',[conversation,owner.workspace.id,owner.user.userId,randomUUID(),project]);
  });
  afterAll(async () => {
    if (app) await app.dataSource.query('DELETE FROM job_histories WHERE id=ANY($1::uuid[])',[runs]);
    if (app) await cleanupE2eData(app.dataSource,{ workspaceIds:[owner?.workspace.id,other?.workspace.id].filter(Boolean),userIds:[owner?.user.userId,other?.user.userId].filter(Boolean) });
    await closeTestApp(app?.app);
  });
  it('serializes repeated proposals, refreshing evidence without creating scanner sightings', async () => {
    const results = await Promise.all([service.propose(input(),context()),service.propose(input(),context())]);
    expect(results.map(r=>r.status).sort()).toEqual(['proposed','updated']);
    expect(new Set(results.map(r=>r.vulnerabilityId)).size).toBe(1);
    const id = results[0].vulnerabilityId;
    const [row] = await app.dataSource.query('SELECT "reviewStatus","discoveredBy","timesDetected","lastScannerObservedAt","scanScopeKey" FROM vulnerabilities WHERE id=$1',[id]);
    expect(row).toEqual({ reviewStatus:'pending_review',discoveredBy:'ai',timesDetected:0,lastScannerObservedAt:null,scanScopeKey:null });
    const sources = await app.dataSource.query('SELECT kind,evidence FROM vulnerability_sources WHERE "vulnerabilityId"=$1',[id]);
    expect(sources).toEqual([{ kind:'ai_agent',evidence }]);
    await request(app.server).post(`/api/vulnerabilities/${id}/review/reject`).set(owner.headers).send({ note:'Not reproducible' }).expect(200);
    expect(await service.propose(input(),context())).toMatchObject({ status:'previously_rejected',vulnerabilityId:id });
  });
  it('enforces current user membership, conversation ownership, tenant, project and cited-call scope', async () => {
    await expect(service.propose(input(),{ ...context(),userId:other.user.userId })).rejects.toThrow();
    await expect(service.propose(input(),{ ...context(),workspaceId:other.workspace.id })).rejects.toThrow();
    await expect(service.propose({ ...input(),assetId:outside },context())).rejects.toMatchObject({ status:404 });
    await expect(service.propose({ ...input(),toolCallIds:['unrelated-call'] },context())).rejects.toMatchObject({ status:400 });
    const stopped = new AbortController(); stopped.abort();
    await expect(service.propose(input('Stopped proposal'),context(),stopped.signal)).rejects.toThrow();
  });
  it('adds proof to an approved same-asset finding without changing scanner lifecycle or provenance', async () => {
    const result = await service.propose(input('Existing approved proof'),context());
    const id = result.vulnerabilityId;
    await request(app.server).post(`/api/vulnerabilities/${id}/review/approve`).set(owner.headers).send({}).expect(200);
    await app.dataSource.query(`UPDATE vulnerabilities SET "detectionStatus"='fixed',"fixedAt"=now(),"timesDetected"=4,"resurfacedCount"=2,"lastScannerObservedAt"=now(),"scanScopeKey"='private-scope' WHERE id=$1`,[id]);
    const columns = '"detectionStatus","fixedAt","timesDetected","resurfacedCount","dueAt","firstDetectedDate","lastSeenDate","lastScannerObservedAt","scanScopeKey"';
    const before = await app.dataSource.query(`SELECT ${columns} FROM vulnerabilities WHERE id=$1`,[id]);
    expect(await service.propose({ ...input(),verifiesVulnerabilityId:id },context())).toMatchObject({ status:'verified',vulnerabilityId:id });
    expect(await app.dataSource.query(`SELECT ${columns} FROM vulnerabilities WHERE id=$1`,[id])).toEqual(before);
    await expect(service.propose({ ...input(),assetId:outside,verifiesVulnerabilityId:id },context())).rejects.toThrow();
    const detail = await request(app.server).get(`/api/vulnerabilities/${id}`).set(owner.headers).expect(200);
    expect(detail.body.sources[0]).toMatchObject({ kind:'ai_agent',evidence,agentConversationId:conversation,createdByUser:{ id:owner.user.userId } });
    expect(Object.keys(detail.body.sources[0].createdByUser).sort()).toEqual(['id','image','name']);
    expect(JSON.stringify(detail.body)).not.toContain('private-scope');
  });
  it('shows attached evidence to finding readers while protecting another users chat and tool-call links', async () => {
    const result = await service.propose(input('Source privacy fixture'),context());
    const member = await insert('INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',[owner.workspace.id,other.user.userId]);
    const role = await insert('INSERT INTO workspace_permissions ("workspaceId",name,permissions) VALUES ($1,$2,$3)',[owner.workspace.id,randomUUID(),['vulnerability.read']]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',[member,role]);
    await app.dataSource.query('UPDATE vulnerability_sources SET "toolCallIds"=$2 WHERE "vulnerabilityId"=$1',[result.vulnerabilityId,['private-call']]);
    const headers = { ...other.headers,'X-Workspace-Id':owner.workspace.id };
    for (const permissions of [['vulnerability.read'],['vulnerability.read','agent.read','job.read']]) {
      await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',[permissions,role]);
      const detail = await request(app.server).get(`/api/vulnerabilities/${result.vulnerabilityId}`).set(headers).expect(200);
      expect(detail.body.sources[0]).toMatchObject({ evidence,agentConversationId:null,toolCallIds:null,jobHistoryId:null });
      expect(detail.body.sources[0]).not.toHaveProperty('createdById');
      expect(JSON.stringify(detail.body)).not.toContain('private-call');
      await request(app.server).post(`/api/vulnerabilities/${result.vulnerabilityId}/review/approve`).set(headers).send({}).expect(403);
    }
    const list = await request(app.server).get('/api/vulnerabilities').query({ status:'pending_review' }).set(headers).expect(200);
    const row=list.body.data.find((finding: { id:string })=>finding.id===result.vulnerabilityId);
    expect(Object.keys(row.sources[0]).sort()).toEqual(['agentName','kind','toolName']);
    expect(row).not.toHaveProperty('reviewNote');
  });
  it('retains standalone Templates run links only while every retained job proves the selected workspace', async () => {
    const result=await service.propose(input('Standalone source provenance'),context());
    const run=await insert('INSERT INTO job_histories ("jobHistoryName") VALUES ($1)',['Standalone template']);runs.push(run);
    const [{ id:tool }]=await app.dataSource.query<{ id:string }[]>("SELECT id FROM tools WHERE name='nuclei' LIMIT 1");
    await app.dataSource.query(`INSERT INTO jobs ("assetId","jobHistoryId","toolId",category) VALUES ($1,$2,$3,'vulnerabilities')`,[asset,run,tool]);
    await app.dataSource.query(`INSERT INTO vulnerability_sources ("vulnerabilityId",kind,"jobHistoryId","toolId") VALUES ($1,'tool',$2,$3)`,[result.vulnerabilityId,run,tool]);
    const detail=await request(app.server).get(`/api/vulnerabilities/${result.vulnerabilityId}`).set(owner.headers).expect(200);
    expect(detail.body.sources.find((source:{ kind:string })=>source.kind==='tool').jobHistoryId).toBe(run);
    const foreignTarget=await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',['foreign-source.example.test','DOMAIN',other.workspace.id]);
    const foreignAsset=await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)',['foreign-source.example.test',foreignTarget]);
    await app.dataSource.query(`INSERT INTO jobs ("assetId","jobHistoryId","toolId",category) VALUES ($1,$2,$3,'vulnerabilities')`,[foreignAsset,run,tool]);
    const mixed=await request(app.server).get(`/api/vulnerabilities/${result.vulnerabilityId}`).set(owner.headers).expect(200);
    expect(mixed.body.sources.find((source:{ kind:string })=>source.kind==='tool').jobHistoryId).toBeNull();
  });
  it('rolls back a proposal stopped while it waits for the identity lock',async()=>{
    const proposal=input('Stopped behind proposal lock');const blocker=app.dataSource.createQueryRunner();
    await blocker.connect();await blocker.startTransaction();const stop=new AbortController();
    try {
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner.workspace.id+':proposal:'+proposalFingerprint(proposal)]);
      const pending=service.propose(proposal,context(),stop.signal);const rejected=expect(pending).rejects.toThrow();
      let waiting=false;
      for(let n=0;n<100;n++) {
        const [row]=await app.dataSource.query<{ waiting:boolean }[]>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' AND query NOT LIKE '%pg_stat_activity%') AS waiting`);
        if(row.waiting){ waiting=true;break; }await delay(10);
      }
      expect(waiting).toBe(true);stop.abort();await blocker.commitTransaction();await rejected;
      expect(await app.dataSource.query('SELECT id FROM vulnerabilities WHERE fingerprint=$1',[proposalFingerprint(proposal)])).toEqual([]);
    } finally { if(blocker.isTransactionActive) await blocker.rollbackTransaction();await blocker.release(); }
  });
});
