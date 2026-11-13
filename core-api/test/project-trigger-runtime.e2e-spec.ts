import { WORKSPACE_HEADER_NAME } from '@/common/constants/app.constants';
import { Workflow } from '@/modules/workflows/entities/workflow.entity';
import { BullMQName, AuditActorType } from '@/common/enums/enum';
import type { ConsumedEvent } from '@/modules/event-bridge/contracts/event-envelope';
import { ProjectTriggerRuntimeService } from '@/modules/projects/project-trigger-runtime.service';
import { ProjectTriggerBatchService } from '@/modules/projects/project-trigger-batch.service';
import { ProjectRunEventsListener } from '@/modules/projects/project-run-events.listener';
import { ProjectsSink } from '@/modules/event-bridge/sinks/projects/projects.sink';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { WorkflowRunnerService } from '@/modules/jobs-registry/workflow-runner.service';
import { RedisService } from '@/services/redis/redis.service';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project trigger management and dispatch (Docker)', () => {
  let app: TestApp,
    owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let runtime: ProjectTriggerRuntimeService,
    batches: ProjectTriggerBatchService,
    events: Queue,
    schedules: Queue;
  let project: string,
    binding: string,
    workflow: string,
    domainAssets: string[],
    ipAsset: string,
    disabledAsset: string;
  const triggers: string[] = [],
    targets: string[] = [],
    legacyKeys: string[] = [];
  const q = async <T = Record<string, unknown>>(
    sql: string,
    args: unknown[] = [],
  ): Promise<T[]> => app.dataSource.query(sql, args);
  const insert = async (sql: string, args: unknown[]) =>
    (await q<{ id: string }>(sql + ' RETURNING id', args))[0].id;
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'trigger-runtime');
    other = await createUserWithWorkspace(app.server, 'trigger-foreign');
    runtime = app.app.get(ProjectTriggerRuntimeService);
    batches = app.app.get(ProjectTriggerBatchService);
    events = app.app.get(getQueueToken(BullMQName.PROJECT_TRIGGER_EVENTS));
    schedules = app.app.get(
      getQueueToken(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE),
    );
    // Test only dispatch into Postgres; no live worker or connector runs.
    await events.pause();
    await schedules.pause();
  });
  async function addBinding(name: string) {
    const workflowId = await insert(
      'INSERT INTO workflows(name,content,"filePath","workspaceId") VALUES($1,$2,$3,$4)',
      [
        name,
        JSON.stringify({
          name,
          jobs: { scan: { run: 'subfinder' } },
          instructions: 'Keep authored instructions',
          on: { target: ['domain.create'] },
        }),
        `project-${project}-${randomUUID()}.yaml`,
        owner.workspace.id,
      ],
    );
    const bindingId = await insert(
      'INSERT INTO project_workflows("projectId","workflowId",schedule,"jobId") VALUES($1,$2,$3,$4)',
      [project, workflowId, '0 6 * * *', 'legacy-key'],
    );
    return { workflowId, bindingId };
  }
  async function asset(
    value: string,
    type = 'DOMAIN',
    enabled = true,
    workspace = owner.workspace.id,
  ) {
    const target = await insert(
      'INSERT INTO targets(value,type,"workspaceId") VALUES($1,$2,$3)',
      [value, type, workspace],
    );
    targets.push(target);
    const id = await insert(
      'INSERT INTO assets(value,"targetId","isPrimary","isEnabled") VALUES($1,$2,true,$3)',
      [value, target, enabled],
    );
    await q('INSERT INTO project_assets("projectId","assetId") VALUES($1,$2)', [
      project,
      id,
    ]);
    return id;
  }
  beforeEach(async () => {
    project = await insert(
      'INSERT INTO projects(name,"workspaceId") VALUES($1,$2)',
      ['Trigger runtime project', owner.workspace.id],
    );
    const added = await addBinding('Discovery');
    workflow = added.workflowId;
    binding = added.bindingId;
    domainAssets = [
      await asset(`${randomUUID()}.example.test`),
      await asset(`${randomUUID()}.example.test`),
    ];
    ipAsset = await asset('192.0.2.' + (targets.length + 10), 'IP');
    disabledAsset = await asset(
      `${randomUUID()}.example.test`,
      'DOMAIN',
      false,
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await q('DELETE FROM projects WHERE id=$1', [project]);
  });
  afterAll(async () => {
    if (!app) return;
    for (const id of triggers) await batches.clear(id);
    for (const job of await events.getJobs([
      'paused',
      'waiting',
      'delayed',
      'failed',
    ]))
      if (triggers.includes(job.data.triggerId as string)) await job.remove();
    for (const key of legacyKeys) await schedules.removeJobScheduler(key);
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await runtime.reconcile();
    await events.resume();
    await schedules.resume();
    await closeTestApp(app.app);
  });
  const path = () => `/api/projects/${project}/triggers`;
  async function create(body: object, forBinding = binding) {
    const { body: row } = await request(app.server)
      .post(path())
      .set(owner.headers)
      .send({ projectWorkflowId: forBinding, ...body })
      .expect(201);
    triggers.push(row.id);
    return row as { id: string; enabled: boolean; lastFiredAt: string | null };
  }
  const patch = (id: string, body: object) =>
    request(app.server).patch(`${path()}/${id}`).set(owner.headers).send(body);
  const event = (payload: unknown, workspaceId = owner.workspace.id) => ({
    payload,
    workspaceId,
    eventId: randomUUID(),
  });
  const token = (id: string) =>
    app.app.get(RedisService).client.get(`project-trigger:${id}:queued`);
  const runs = () =>
    q<{
      id: string;
      scope: { assetIds: string[] };
      triggerId: string;
      chainDepth: number;
      causedByRunId: string | null;
      jobRunType: string;
    }>(
      'SELECT id,scope,"triggerId","chainDepth","causedByRunId","jobRunType" FROM job_histories WHERE "projectId"=$1 ORDER BY id',
      [project],
    );

  it('manages schedules atomically while preserving legacy preferences and authored content', async () => {
    const legacy = `legacy-proof-${randomUUID()}`;
    legacyKeys.push(legacy);
    await schedules.upsertJobScheduler(
      legacy,
      { pattern: '0 6 * * *' },
      { name: 'legacy-proof', data: { id: binding } },
    );
    const [before] = await q('SELECT * FROM project_workflows WHERE id=$1', [
      binding,
    ]);
    const row = await create({ type: 'cron', cron: '0 8 * * *' });
    expect(row.enabled).toBe(false);
    await patch(row.id, { enabled: true }).expect(200);
    expect(
      await schedules.getJobScheduler(`project-trigger:${row.id}`),
    ).toMatchObject({ pattern: '0 8 * * *', tz: 'UTC' });
    await patch(row.id, { cron: ' 0  9 * * * ' }).expect(200);
    expect(
      await schedules.getJobScheduler(`project-trigger:${row.id}`),
    ).toMatchObject({ pattern: '0 9 * * *' });
    for (const invalid of [
      {},
      { enabled: null },
      { cron: 'bad' },
      { config: {} },
      { type: 'event' },
    ])
      await patch(row.id, invalid).expect(400);
    await request(app.server)
      .post(path())
      .set(owner.headers)
      .send({ projectWorkflowId: binding, type: 'cron', cron: '0 9 * * *' })
      .expect(400);
    await request(app.server)
      .delete(`${path()}/${row.id}`)
      .set(owner.headers)
      .expect(200, { message: 'Trigger removed' });
    expect(
      (await schedules.getJobSchedulers()).some(
        (item) => item.key === `project-trigger:${row.id}`,
      ),
    ).toBe(false);
    expect(await schedules.getJobScheduler(legacy)).toMatchObject({
      pattern: '0 6 * * *',
    });
    const [after] = await q<{ id: string; projectId: string; workflowId: string; schedule: string; jobId: string }>('SELECT * FROM project_workflows WHERE id=$1', [binding]);
    expect(after).toMatchObject({ id: before.id, projectId: before.projectId, workflowId: before.workflowId, schedule: before.schedule, createdAt: before.createdAt });
    expect(await schedules.getJobScheduler(after.jobId)).toMatchObject({ name: binding, pattern: '0 6 * * *' });
    expect(
      (
        await q<{ content: object }>(
          'SELECT content FROM workflows WHERE id=$1',
          [workflow],
        )
      )[0].content,
    ).toMatchObject({
      instructions: 'Keep authored instructions',
      on: { target: ['domain.create'] },
    });
    expect(await runs()).toEqual([]);
  });
  it('denies cross-workspace, read-only, archived and malformed management requests', async () => {
    const row = await create({ type: 'event', event: 'project.assets.added' });
    await request(app.server)
      .patch(`${path()}/${row.id}`)
      .set(other.headers)
      .send({ enabled: true })
      .expect(404);
    const member = await insert(
      'INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)',
      [owner.workspace.id, other.user.userId],
    );
    const permission = await insert(
      'INSERT INTO workspace_permissions(name,permissions,"workspaceId") VALUES($1,$2,$3)',
      [randomUUID(), ['project.read'], owner.workspace.id],
    );
    await q(
      'INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)',
      [member, permission],
    );
    const readHeaders = {
      ...other.headers,
      [WORKSPACE_HEADER_NAME]: owner.workspace.id,
    };
    await request(app.server)
      .patch(`${path()}/${row.id}`)
      .set(readHeaders)
      .send({ enabled: true })
      .expect(403);
    await request(app.server)
      .delete(`${path()}/${row.id}`)
      .set(readHeaders)
      .expect(403);
    await patch(randomUUID(), { enabled: true }).expect(404);
    await request(app.server)
      .patch(`${path()}/invalid`)
      .set(owner.headers)
      .send({ enabled: true })
      .expect(400);
    await request(app.server)
      .patch(`${path()}/${row.id}`)
      .send({ enabled: true })
      .expect(401);
    await q('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [project]);
    await patch(row.id, { enabled: true }).expect(400);
    await request(app.server)
      .delete(`${path()}/${row.id}`)
      .set(owner.headers)
      .expect(400);
  });
  it('round-trips workflow on input, preserves omitted definitions, and rolls back invalid replacements', async () => {
    const { body: created } = await request(app.server)
      .post(`/api/projects/${project}/workflows`)
      .set(owner.headers)
      .send({
        name: 'Managed pipeline',
        jobs: { scan: { run: 'subfinder' } },
        on: {
          schedule: [{ cron: '0 11 * * *', enabled: true }],
          events: [{ event: 'project.assets.added', maxAssets: 4 }],
        },
      })
      .expect(201);
    const rows = await q<{ id: string; enabled: boolean; type: string }>(
      'SELECT * FROM project_workflow_triggers WHERE "projectWorkflowId"=$1 ORDER BY type',
      [created.id],
    );
    triggers.push(...rows.map((r) => r.id));
    expect(rows.map((r) => [r.type, r.enabled])).toEqual([
      ['cron', true],
      ['event', false],
    ]);
    await request(app.server)
      .patch(`/api/projects/${project}/workflows/${created.id}`)
      .set(owner.headers)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(
      await q(
        'SELECT id,enabled FROM project_workflow_triggers WHERE "projectWorkflowId"=$1 ORDER BY type',
        [created.id],
      ),
    ).toEqual(rows.map(({ id, enabled }) => ({ id, enabled })));
    for (const on of [
      { schedule: [{ cron: 'bad' }] },
      { events: [{ event: 'unknown' }] },
      { extra: true },
      { schedule: Array.from({ length: 21 }, () => ({ cron: '0 1 * * *' })) },
    ])
      await request(app.server)
        .patch(`/api/projects/${project}/workflows/${created.id}`)
        .set(owner.headers)
        .send({ name: 'Must roll back', on })
        .expect(400);
    expect(
      (
        await q<{ name: string }>('SELECT name FROM workflows WHERE id=$1', [
          created.workflowId,
        ])
      )[0].name,
    ).toBe('Renamed');
    await request(app.server)
      .patch(`/api/projects/${project}/workflows/${created.id}`)
      .set(owner.headers)
      .send({ on: {} })
      .expect(200);
    expect(
      await q(
        'SELECT id FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
        [created.id],
      ),
    ).toEqual([]);
  });
  it('creates one scheduled run on duplicate cron delivery and respects disabled/archived state', async () => {
    const row = await create({
      type: 'cron',
      cron: '0 8 * * *',
      enabled: true,
    });
    await Promise.all([
      runtime.fireCron(row.id, 'same-firing'),
      runtime.fireCron(row.id, 'same-firing'),
    ]);
    expect(await runs()).toHaveLength(1);
    expect((await runs())[0]).toMatchObject({
      triggerId: row.id,
      jobRunType: 'scheduled',
      chainDepth: 0,
      causedByRunId: null,
    });
    expect((await runs())[0].scope.assetIds.sort()).toEqual(
      [...domainAssets, ipAsset].sort(),
    );
    await patch(row.id, { enabled: false }).expect(200);
    await runtime.fireCron(row.id, 'later');
    await q('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [project]);
    await runtime.fireCron(row.id, 'archived');
    expect(await runs()).toHaveLength(1);
  });
  it('filters event assets by tenant/type/enabled membership and recovers after a durable launch', async () => {
    const foreign = await asset(
      `${randomUUID()}.example.test`,
      'DOMAIN',
      true,
      other.workspace.id,
    );
    const row = await create({
      type: 'event',
      event: 'project.assets.added',
      config: { windowMinutes: 10, maxAssets: 1, targetTypes: ['DOMAIN'] },
      enabled: true,
    });
    const delivery = event({
      projectId: project,
      assetIds: [
        ...domainAssets,
        domainAssets[0],
        ipAsset,
        disabledAsset,
        foreign,
      ],
    });
    await app.app.get(ProjectsSink).handle('project.assets.added', delivery);
    await app.app.get(ProjectsSink).handle('project.assets.added', delivery);
    const queued = await token(row.id);
    expect(queued).toBeTruthy();
    const runner = app.app.get(WorkflowRunnerService),
      original = runner.startRun.bind(runner);
    const start = jest
      .spyOn(runner, 'startRun')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('lost after durable handoff');
      });
    await expect(
      runtime.fireEvent({ triggerId: row.id, token: queued! }),
    ).rejects.toThrow('lost after durable handoff');
    expect(await runs()).toHaveLength(1);
    start.mockRestore();
    await patch(row.id, { config: { maxAssets: 2 } }).expect(200);
    await runtime.fireEvent({ triggerId: row.id, token: queued! });
    await runtime.fireEvent({ triggerId: row.id, token: queued! });
    expect(await runs()).toHaveLength(2);
    const listed = await request(app.server).get(`/api/projects/${project}/runs?jobRunType=event`).set(owner.headers).expect(200);
    expect(listed.body.data).toHaveLength(2);
    for (const item of listed.body.data as Record<string, unknown>[]) for (const field of ['triggerId','causedByRunId','chainDepth']) expect(item).not.toHaveProperty(field);
    expect((await runs()).flatMap((run) => run.scope.assetIds).sort()).toEqual(
      domainAssets.sort(),
    );
    expect(
      (
        await q<{ n: number }>(
          'SELECT count(*)::int AS n FROM jobs j JOIN job_histories h ON h.id=j."jobHistoryId" WHERE h."projectId"=$1',
          [project],
        )
      )[0].n,
    ).toBe(2);
  });
  async function cause(
    depth: number,
    status: 'done' | 'failed' | 'cancelled' = 'done',
  ) {
    return insert(
      'INSERT INTO job_histories("workflowId","projectId","projectWorkflowId","chainDepth",scope,steps,"isCompleted") VALUES($1,$2,$3,$4,$5,$6,true)',
      [
        workflow,
        project,
        binding,
        depth,
        JSON.stringify({ assetIds: domainAssets }),
        JSON.stringify({
          scan:
            status === 'cancelled'
              ? { status: 'skipped', reason: 'run-cancelled' }
              : { status },
        }),
      ],
    );
  }
  it('uses authoritative completion outcome, suppresses self/cancelled loops and caps chains at three', async () => {
    const listener = await addBinding('After discovery');
    const own = await create({
      type: 'event',
      event: 'project.run.completed',
      config: { windowMinutes: 10, status: ['failure'] },
      enabled: true,
    });
    const child = await create(
      {
        type: 'event',
        event: 'project.run.completed',
        config: {
          windowMinutes: 10,
          status: ['failure'],
          workflows: [' discovery '],
        },
        enabled: true,
      },
      listener.bindingId,
    );
    const run = await cause(2, 'failed');
    const payload = {
      projectId: project,
      projectWorkflowId: binding,
      workflowName: 'forged name ignored',
      jobHistoryId: run,
      outcome: 'success',
    };
    await runtime.handleEvent('project.run.completed', event(payload));
    expect(await token(own.id)).toBeNull();
    const queued = await token(child.id);
    expect(queued).toBeTruthy();
    await runtime.fireEvent({ triggerId: child.id, token: queued! });
    expect((await runs()).filter((r) => r.triggerId === child.id)).toEqual([
      expect.objectContaining({
        chainDepth: 3,
        causedByRunId: run,
        jobRunType: 'event',
      }),
    ]);
    const capped = await cause(3, 'failed');
    await runtime.handleEvent(
      'project.run.completed',
      event({ ...payload, jobHistoryId: capped }),
    );
    expect(await token(child.id)).toBeNull();
    const cancelled = await cause(0, 'cancelled');
    await runtime.handleEvent(
      'project.run.completed',
      event({ ...payload, jobHistoryId: cancelled }),
    );
    expect(await token(child.id)).toBeNull();
    const bridge = app.app.get(EventBridgeService),
      publish = jest.spyOn(bridge, 'publishSafely').mockResolvedValue(null);
    await app.app.get(ProjectRunEventsListener).onRunClosed(run);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project.run.completed' }),
      expect.objectContaining({
        workspaceId: owner.workspace.id,
        payload: {
          projectId: project,
          projectWorkflowId: binding,
          workflowName: 'Discovery',
          jobHistoryId: run,
          outcome: 'failure',
        },
      }),
    );
    publish.mockClear();
    await app.app.get(ProjectRunEventsListener).onRunClosed(cancelled);
    expect(publish).not.toHaveBeenCalled();
  });
  it('routes finding severities only for the recorded job asset and suppresses the source workflow', async () => {
    const listener = await addBinding('Review findings');
    const own = await create({
      type: 'event',
      event: 'vulnerability.detected',
      config: { windowMinutes: 10, severity: ['high'] },
      enabled: true,
    });
    const child = await create(
      {
        type: 'event',
        event: 'vulnerability.detected',
        config: { windowMinutes: 10, severity: ['high'] },
        enabled: true,
      },
      listener.bindingId,
    );
    const run = await cause(0);
    const [tool] = await q<{ id: string }>(
      `SELECT t.id FROM tools t WHERE t.name='nuclei' LIMIT 1`,
      [],
    );
    const job = await insert(
      'INSERT INTO jobs("jobHistoryId","assetId","toolId",category,status) VALUES($1,$2,$3,$4,$5)',
      [run, domainAssets[0], tool.id, 'vulnerabilities', 'completed'],
    );
    const payload = {
      jobId: job,
      assetId: domainAssets[0],
      vulnerabilities: [{ severity: 'medium' }],
    };
    await runtime.handleEvent('vulnerability.detected', event(payload));
    expect(await token(child.id)).toBeNull();
    await app.app
      .get(ProjectsSink)
      .handle(
        'vulnerability.detected',
        event({ ...payload, vulnerabilities: [{ severity: 'high' }] }),
      );
    expect(await token(own.id)).toBeNull();
    expect(await token(child.id)).toBeTruthy();
    await runtime.fireEvent({
      triggerId: child.id,
      token: (await token(child.id))!,
    });
    expect((await runs()).filter((r) => r.triggerId === child.id)).toEqual([
      expect.objectContaining({
        scope: { assetIds: [domainAssets[0]] },
        causedByRunId: run,
        chainDepth: 1,
      }),
    ]);
    await runtime.handleEvent(
      'vulnerability.detected',
      event({
        ...payload,
        assetId: ipAsset,
        vulnerabilities: [{ severity: 'high' }],
      }),
    );
    expect(await token(child.id)).toBeNull();
  });
  it('launches once for a durable human approval without inventing scanner jobs or coverage',async()=>{
    const row=await create({ type:'event',event:'vulnerability.detected',enabled:true,config:{ windowMinutes:10,severity:['high'] } });
    const id=await insert(`INSERT INTO vulnerabilities (name,fingerprint,"assetId","reviewStatus","discoveredBy",severity,"timesDetected") VALUES ($1,$2,$3,'pending_review','ai','high',0)`,['Approval automation',randomUUID(),domainAssets[0]]);
    const publish=jest.spyOn(app.app.get(EventBridgeService),'publishSafely').mockResolvedValue(null);
    await request(app.server).post(`/api/vulnerabilities/${id}/review/approve`).set(owner.headers).send({}).expect(200);
    const published=publish.mock.calls.find(([definition])=>typeof definition!=='string'&&definition.name==='vulnerability.detected');
    expect(published).toBeDefined();
    const approval={ ...(published![1] as Omit<ConsumedEvent,'eventId'>),eventId:randomUUID() };
    const payload=approval.payload as Record<string,unknown>;
    await runtime.handleEvent('vulnerability.detected',{ ...approval,metadata:{ approvalEventId:randomUUID() } });
    await runtime.handleEvent('vulnerability.detected',{ ...approval,actor:{ type:AuditActorType.User,id:other.user.userId } });
    await runtime.handleEvent('vulnerability.detected',{ ...approval,payload:{ ...payload,assetId:ipAsset } });
    await q(`UPDATE vulnerabilities SET "reviewStatus"='rejected' WHERE id=$1`,[id]);
    await runtime.handleEvent('vulnerability.detected',approval);
    expect(await token(row.id)).toBeNull();
    await q(`UPDATE vulnerabilities SET "reviewStatus"='approved' WHERE id=$1`,[id]);
    await runtime.handleEvent('vulnerability.detected',approval);
    const queued=await token(row.id);expect(queued).toBeTruthy();
    await runtime.handleEvent('vulnerability.detected',approval);expect(await token(row.id)).toBe(queued);
    await runtime.fireEvent({ triggerId:row.id,token:queued! });
    expect((await runs()).filter(run=>run.triggerId===row.id)).toEqual([expect.objectContaining({ causedByRunId:null,chainDepth:0,scope:{ assetIds:[domainAssets[0]] } })]);
    await runtime.handleEvent('vulnerability.detected',approval);expect(await token(row.id)).toBeNull();
    const [finding]=await q('SELECT "timesDetected","lastScannerObservedAt","scanScopeKey" FROM vulnerabilities WHERE id=$1',[id]);
    expect(finding).toEqual({ timesDetected:0,lastScannerObservedAt:null,scanScopeKey:null });
  });
  it('revalidates cancellation after gathering and before launching the child', async () => {
    const row = await create({
      type: 'event',
      event: 'project.assets.added',
      enabled: true,
    });
    const run = await cause(0);
    await runtime.handleEvent(
      'project.assets.added',
      event({ projectId: project, assetIds: domainAssets, jobHistoryId: run }),
    );
    const queued = await token(row.id);
    expect(queued).toBeTruthy();
    await q('UPDATE job_histories SET steps=$1 WHERE id=$2', [
      JSON.stringify({ scan: { status: 'skipped', reason: 'run-cancelled' } }),
      run,
    ]);
    await runtime.fireEvent({ triggerId: row.id, token: queued! });
    expect((await runs()).filter((r) => r.triggerId === row.id)).toEqual([]);
  });
  it('restores an enabled cron when an identical legacy scheduler reference is stale', async () => {
    const row = await create({
      type: 'cron',
      cron: '0 6 * * *',
      enabled: true,
    });
    const [restored] = await q<{ jobId: string }>('SELECT "jobId" FROM project_workflows WHERE id=$1', [binding]);
    expect(await schedules.getJobScheduler(restored.jobId)).toMatchObject({ name: binding, pattern: '0 6 * * *' });
    expect((await schedules.getJobSchedulers()).filter(item => item.name === binding || item.key === `project-trigger:${row.id}`)).toHaveLength(1);
  });
  it('emits project completion for a real no-inputs run with no job rows', async () => {
    const source = await addBinding('No services'),
      listener = await addBinding('After empty probe');
    await q('UPDATE workflows SET content=$1 WHERE id=$2', [
      JSON.stringify({
        name: 'No services',
        jobs: { probe: { run: 'httpx' } },
      }),
      source.workflowId,
    ]);
    await q(
      `INSERT INTO workspace_tools("workspaceId","toolId") SELECT $1,t.id FROM tools t WHERE t.name='httpx' AND NOT EXISTS(SELECT 1 FROM workspace_tools wt WHERE wt."workspaceId"=$1 AND wt."toolId"=t.id)`,
      [owner.workspace.id],
    );
    const row = await create(
      {
        type: 'event',
        event: 'project.run.completed',
        config: { windowMinutes: 10 },
        enabled: true,
      },
      listener.bindingId,
    );
    const workflowEntity = await app.dataSource
      .getRepository(Workflow)
      .findOneOrFail({
        where: { id: source.workflowId },
        relations: { workspace: true },
      });
    const result = await app.app
      .get(WorkflowRunnerService)
      .startRun({
        workflow: workflowEntity,
        workspaceId: owner.workspace.id,
        jobName: 'No services',
        assetIds: domainAssets,
        projectId: project,
        projectWorkflowId: source.bindingId,
      });
    expect(result.dispatched).toBe(0);
    const [closed] = await q<{ isCompleted: boolean; steps: object }>(
      'SELECT "isCompleted",steps FROM job_histories WHERE id=$1',
      [result.jobHistory!.id],
    );
    expect(closed).toMatchObject({
      isCompleted: true,
      steps: { probe: { status: 'skipped', reason: 'no-inputs' } },
    });
    for (let attempt = 0; attempt < 100 && !(await token(row.id)); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await token(row.id)).toBeTruthy();
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects own %s keys in workflow on input before stripping',
    async (key) => {
      const on =
        '{"events":[{"event":"project.assets.added","' + key + '":{}}]}';
      await request(app.server)
        .patch(`/api/projects/${project}/workflows/${binding}`)
        .set(owner.headers)
        .set('Content-Type', 'application/json')
        .send('{"on":' + on + '}')
        .expect(400);
      await request(app.server)
        .post(`/api/projects/${project}/workflows`)
        .set(owner.headers)
        .set('Content-Type', 'application/json')
        .send('{"jobs":{"scan":{"run":"subfinder"}},"on":' + on + '}')
        .expect(400);
      expect(
        await q(
          'SELECT id FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
          [binding],
        ),
      ).toEqual([]);
    },
  );
});
