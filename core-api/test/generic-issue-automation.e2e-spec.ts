import { AgentTool } from '@/modules/agents/agents.tools';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';
import { DataAdapterService } from '@/modules/data-adapter/data-adapter.service';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { Job } from '@/modules/jobs-registry/entities/job.entity';
import type { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { Severity } from '@/common/enums/enum';
import { IssueAutomationService } from '@/modules/issues/issue-automation.service';

describe('Issue automation durable proof (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let asset: string;
  let tool: string;
  let workflow: string;
  const readers: string[] = [];
  const createFinding = async (name: string, reviewStatus = 'approved') => {
    const [row] = await app.dataSource.query('INSERT INTO vulnerabilities(name,fingerprint,"assetId",severity,"reviewStatus","discoveredBy","timesDetected") VALUES($1,$2,$3,\'critical\',$4,\'ai\',0) RETURNING id', [name, randomUUID(), asset, reviewStatus]);
    return row.id as string;
  };
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0, '127.0.0.1');
    owner = await createUserWithWorkspace(app.server, 'issue-proof');
    const [target] = await app.dataSource.query('INSERT INTO targets(value,type,"workspaceId") VALUES(\'proof.example.test\',\'DOMAIN\',$1) RETURNING id', [owner.workspace.id]);
    const [row] = await app.dataSource.query('INSERT INTO assets(value,"targetId") VALUES(\'proof.example.test\',$1) RETURNING id', [target.id]);
    asset = row.id;
    [tool] = (await app.dataSource.query('INSERT INTO tools(name,categories) VALUES($1,$2) RETURNING id', [randomUUID(), JSON.stringify([{ name: 'vulnerabilities', targetTypes: ['DOMAIN'] }])])).map((row: { id: string }) => row.id);
    [workflow] = (await app.dataSource.query(`INSERT INTO workflows(name,content,"filePath","workspaceId") VALUES($1,'{}',$1,$2) RETURNING id`, [randomUUID(), owner.workspace.id])).map((row: { id: string }) => row.id);
    await request(app.server).post('/api/issues/rules/defaults').set(owner.headers).send({}).expect(201);
  });
  afterAll(async () => {
    if (app) await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id].filter(Boolean), userIds: [owner?.user.userId, ...readers].filter(Boolean) });
    if (tool) await app.dataSource.query('DELETE FROM tools WHERE id=$1', [tool]);
    await closeTestApp(app?.app);
  });

  it('does not create issues from an event payload without a durable finding proof', async () => {
    const id = await createFinding('Unproved event sentinel');
    await app.app.get(IssueAutomationService).onVulnerabilityEvent({ event: 'vulnerability.detected', workspaceId: owner.workspace.id, vulnerabilityIds: [id], proofIds: [], eventId: randomUUID() } as never);
    const rows = await app.dataSource.query('SELECT id FROM issue_links WHERE "resourceId"=$1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('accepts a real human approval once and retains its receipt after issue deletion', async () => {
    const id = await createFinding('Approved issue proof', 'pending_review');
    await request(app.server).post(`/api/vulnerabilities/${id}/review/approve`).set(owner.headers).send({}).expect(200);
    const [proof] = await app.dataSource.query('SELECT id FROM vulnerability_events WHERE "vulnerabilityId"=$1 AND type=\'approved\'', [id]);
    const fact = { event: 'vulnerability.detected', workspaceId: owner.workspace.id, vulnerabilityIds: [id], proofIds: [proof.id], actorUserId: owner.user.userId, eventId: randomUUID() };
    const service = app.app.get(IssueAutomationService);
    await service.onVulnerabilityEvent(fact as never);
    const links = await app.dataSource.query('SELECT "issueId" FROM issue_links WHERE "resourceId"=$1', [id]);
    expect(links).toHaveLength(1);
    const reader = await createUser(app.server, { name: 'Issues only' }); readers.push(reader.userId);
    const [member] = await app.dataSource.query('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2) RETURNING id', [owner.workspace.id, reader.userId]);
    const [role] = await app.dataSource.query('INSERT INTO workspace_permissions("workspaceId",name,permissions) VALUES($1,\'Issues only\',$2) RETURNING id', [owner.workspace.id, ['workspace.read']]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)', [member.id, role.id]);
    const restricted = await request(app.server).get(`/api/issues/${links[0].issueId}`).set({ Cookie: reader.cookie, 'X-Workspace-Id': owner.workspace.id });
    expect({ status: restricted.status, body: restricted.body }).toMatchObject({ status: 200 });
    expect(restricted.body.title).toBe(`Remediation issue #${restricted.body.no}`);
    expect(restricted.body.groupKey).toBeNull();
    expect(restricted.body.links).toEqual([]);
    const search = await request(app.server).get('/api/issues').query({ search: 'Approved issue proof' }).set({ Cookie: reader.cookie, 'X-Workspace-Id': owner.workspace.id }).expect(200);
    expect(search.body.total).toBe(0);
    const timeline = await request(app.server).get(`/api/vulnerabilities/${id}/timeline`).set(owner.headers).expect(200);
    expect(timeline.body.data.map((row: { type: string }) => row.type)).toContain('issue_linked');
    expect(timeline.body.data.map((row: { type: string }) => row.type)).not.toContain('issue_automation');
    await service.onVulnerabilityEvent({ ...fact, eventId: randomUUID() } as never);
    expect(await app.dataSource.query('SELECT id FROM issue_links WHERE "resourceId"=$1', [id])).toHaveLength(1);
    await request(app.server).delete(`/api/issues/${links[0].issueId}`).set(owner.headers).expect(200);
    await service.onVulnerabilityEvent({ ...fact, eventId: randomUUID() } as never);
    expect(await app.dataSource.query('SELECT id FROM issue_links WHERE "resourceId"=$1', [id])).toHaveLength(0);
  });
  it('publishes scanner proofs only after commit, resolves a trusted fix and protects a newer manual decision', async () => {
    const [run] = await app.dataSource.query('INSERT INTO job_histories("workflowId") VALUES($1) RETURNING id', [workflow]);
    const [row] = await app.dataSource.query(`INSERT INTO jobs("assetId","toolId","jobHistoryId",category,status,"findingScanScopeKey","findingScanClaimedAt") VALUES($1,$2,$3,'vulnerabilities','in_progress',$4,statement_timestamp()) RETURNING id`, [asset, tool, run.id, 'f'.repeat(64)]);
    const job = await app.dataSource.getRepository(Job).findOneOrFail({ where: { id: row.id }, relations: { asset: { target: true }, tool: true, jobHistory: true } });
    const original = app.app.get(EventBridgeService).publishSafely.bind(app.app.get(EventBridgeService));
    const delivered: { name: string; data: { metadata?: { findingEventIds?: string[] } } }[] = [];
    const spy = jest.spyOn(app.app.get(EventBridgeService), 'publishSafely').mockImplementation(async (...args) => {
      const [event, data] = args;
      if (event.name === 'vulnerability.detected' || event.name === 'vulnerability.resurfaced') {
        const ids = (data.metadata as { findingEventIds?: string[] }).findingEventIds ?? [];
        expect(ids.length).toBeGreaterThan(0);
        expect(await app.dataSource.query('SELECT id FROM vulnerability_events WHERE id=ANY($1::uuid[])', [ids])).toHaveLength(ids.length);
        delivered.push({ name: event.name, data: data as never });
      }
      const result: unknown = await original(...args); return result;
    });
    const name = 'Scanner issue ' + randomUUID();
    try { await app.app.get(DataAdapterService).vulnerabilities({ job, data: [{ name, severity: Severity.CRITICAL } as Vulnerability] }); }
    finally { spy.mockRestore(); }
    const [finding] = await app.dataSource.query('SELECT id FROM vulnerabilities WHERE name=$1', [name]);
    const service = app.app.get(IssueAutomationService);
    const detected = { event: 'vulnerability.detected', workspaceId: owner.workspace.id, vulnerabilityIds: [finding.id], jobId: job.id, proofIds: delivered[0].data.metadata!.findingEventIds, eventId: randomUUID() };
    await Promise.all([service.onVulnerabilityEvent(detected as never), service.onVulnerabilityEvent({ ...detected, eventId: randomUUID() } as never)]);
    const links = await app.dataSource.query('SELECT "issueId" FROM issue_links WHERE "resourceId"=$1', [finding.id]);
    expect(links).toHaveLength(1);
    const [proof] = await app.dataSource.query(`WITH fixed AS (UPDATE vulnerabilities SET "detectionStatus"='fixed',"fixedAt"=statement_timestamp() WHERE id=$1 RETURNING *) INSERT INTO vulnerability_events("workspaceId","vulnerabilityId",type,"fromStatus","toStatus","jobHistoryId",data,"occurredAt") SELECT $2,id,'status_changed','active','fixed',$3,'{"reason":"not_detected_by_covering_scan","coverageVersion":1}',"fixedAt" FROM fixed RETURNING id`, [finding.id, owner.workspace.id, run.id]);
    const fixed = { event: 'vulnerability.fixed', workspaceId: owner.workspace.id, vulnerabilityIds: [finding.id], jobHistoryId: run.id, proofIds: [proof.id], eventId: randomUUID() };
    await service.onVulnerabilityEvent(fixed as never);
    expect((await request(app.server).get('/api/issues/' + links[0].issueId).set(owner.headers).expect(200)).body).toMatchObject({ status: 'resolved', resolution: 'fixed' });
    const comments = await app.dataSource.query('SELECT content FROM comments WHERE "issueId"=$1', [links[0].issueId]);
    expect(JSON.stringify(comments)).not.toContain(run.id);
    await request(app.server).patch('/api/issues/' + links[0].issueId + '/status').set(owner.headers).send({ status: 'open' }).expect(200);
    await service.onVulnerabilityEvent({ ...fixed, eventId: randomUUID() } as never);
    expect((await request(app.server).get('/api/issues/' + links[0].issueId).set(owner.headers).expect(200)).body.status).toBe('open');
  });

  it('processes surviving proofs when a sibling finding was deleted before delivery', async () => {
    const ids = await Promise.all([createFinding('Deleted proof sibling', 'pending_review'), createFinding('Surviving proof sibling', 'pending_review')]);
    for (const id of ids) await request(app.server).post('/api/vulnerabilities/' + id + '/review/approve').set(owner.headers).send({}).expect(200);
    const proofs = await app.dataSource.query(`SELECT id FROM vulnerability_events WHERE "vulnerabilityId"=ANY($1::uuid[]) AND type='approved'`, [ids]);
    await app.dataSource.query('DELETE FROM vulnerabilities WHERE id=$1', [ids[0]]);
    await app.app.get(IssueAutomationService).onVulnerabilityEvent({ event: 'vulnerability.detected', workspaceId: owner.workspace.id, vulnerabilityIds: ids, proofIds: proofs.map((p: { id: string }) => p.id), actorUserId: owner.user.userId } as never);
    expect(await app.dataSource.query('SELECT id FROM issue_links WHERE "resourceId"=$1', [ids[1]])).toHaveLength(1);
  });

  it('rechecks dismissal expiry after waiting for the workspace lock', async () => {
    const ids = await Promise.all([createFinding('Finished locking fixture'), createFinding('Expired acceptance fixture')]);
    const created = await request(app.server).post('/api/issues').set(owner.headers).send({ title: 'Queued expiry check', type: 'vulnerability_remediation', links: ids.map(resourceId => ({ resourceType: 'vulnerability', resourceId })) }).expect(201);
    const [run] = await app.dataSource.query('INSERT INTO job_histories("workflowId") VALUES($1) RETURNING id', [workflow]);
    const [proof] = await app.dataSource.query(`WITH fixed AS (UPDATE vulnerabilities SET "detectionStatus"='fixed',"fixedAt"=statement_timestamp() WHERE id=$1 RETURNING *) INSERT INTO vulnerability_events("workspaceId","vulnerabilityId",type,"fromStatus","toStatus","jobHistoryId",data,"occurredAt") SELECT $2,id,'status_changed','active','fixed',$3,'{"reason":"not_detected_by_covering_scan","coverageVersion":1}',"fixedAt" FROM fixed RETURNING id`, [ids[0], owner.workspace.id, run.id]);
    await app.dataSource.query(`INSERT INTO vulnerability_dismissals("vulnerabilityId",reason,"userId","expiresAt") VALUES($1,'risk_accepted',$2,statement_timestamp()+interval '300 milliseconds')`, [ids[1], owner.user.userId]);
    const runner=app.dataSource.createQueryRunner();await runner.connect();await runner.startTransaction();
    await runner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['issues:'+owner.workspace.id]);
    const work=app.app.get(IssueAutomationService).onVulnerabilityEvent({ event:'vulnerability.fixed',workspaceId:owner.workspace.id,vulnerabilityIds:[ids[0]],proofIds:[proof.id],jobHistoryId:run.id } as never);
    try {
      for (let n=0;n<100;n++) {
        const [waiting]=await app.dataSource.query(`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`);
        if (waiting.count) break;
        await new Promise(resolve=>setTimeout(resolve,10));
        if (n===99) throw new Error('Automation did not wait for workspace lock');
      }
      await new Promise(resolve=>setTimeout(resolve,350));
      await runner.commitTransaction();await work;
    } finally { if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release(); }
    expect((await request(app.server).get('/api/issues/'+created.body.id).set(owner.headers).expect(200)).body.status).toBe('open');
  });

  it('executes registered model issue reads with current member permissions and workspace-key compatibility', async () => {
    const agent=app.app.get(AgentTool);
    const execute=async(tools:ReturnType<AgentTool['getMcpTools']>,name:string,input:object):Promise<unknown>=>{
      const tool=tools[name];
      const call=tool.execute as (input:object,options:{toolCallId:string;messages:never[]})=>Promise<unknown>;
      return call(input,{ toolCallId:randomUUID(),messages:[] });
    };
    expect(await execute(agent.getMcpTools(owner.workspace.id),'enumerate_open_issues',{ page:1,limit:10,type:['task'] })).toEqual(expect.objectContaining({ data:expect.any(Array) }));
    const reader=await createUser(app.server,{ name:'Model issue reader' });readers.push(reader.userId);
    const [member]=await app.dataSource.query('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2) RETURNING id',[owner.workspace.id,reader.userId]);
    const [role]=await app.dataSource.query('INSERT INTO workspace_permissions("workspaceId",name,permissions) VALUES($1,$2,$3) RETURNING id',[owner.workspace.id,'Model issues',['workspace.read']]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)',[member.id,role.id]);
    const tools=agent.getMcpTools(owner.workspace.id,reader.userId);
    expect(await execute(tools,'enumerate_open_issues',{ page:1,limit:10 })).toEqual(expect.objectContaining({ data:expect.any(Array) }));
    await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',[[],role.id]);
    expect(await execute(tools,'enumerate_open_issues',{ page:1,limit:10 })).toEqual(expect.objectContaining({ success:false }));
  });

});
