import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import { getQueueToken } from '@nestjs/bullmq';
import { BullMQName } from '@/common/enums/enum';
import type { Queue } from 'bullmq';
import {
  ProjectTriggerBatchService,
  type ProjectTriggerEventJob,
} from '@/modules/projects/project-trigger-batch.service';
import { ProjectTriggerRuntimeService } from '@/modules/projects/project-trigger-runtime.service';
import { WorkflowRunnerService } from '@/modules/jobs-registry/workflow-runner.service';
import { ProjectLegacyScheduleService } from '@/modules/projects/project-legacy-schedule.service';
import { AssetGroupWorkflowService } from '@/modules/asset-group/asset-group-workflow.service';
import { JobRunType } from '@/common/enums/enum';
import { NotFoundException } from '@nestjs/common';
import { triggerEpoch } from '@/modules/projects/project-archive-state';
import type { ConsumedEvent } from '@/modules/event-bridge/contracts/event-envelope';

describe('Project archive/reopen (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let role: string;
  const q = (sql: string, args: unknown[] = []) =>
    app.dataSource.query<Record<string, unknown>[]>(sql, args);
  const insert = async (sql: string, args: unknown[]) =>
    (await q(sql + ' RETURNING id', args))[0].id as string;
  const url = (id: string) => '/api/projects/' + id;
  const reader = () => ({
    ...other.headers,
    'X-Workspace-Id': owner.workspace.id,
  });
  const post = (
    id: string,
    action: 'archive' | 'unarchive',
    headers = owner.headers,
  ) =>
    request(app.server)
      .post(url(id) + '/' + action)
      .set(headers)
      .send({});
  async function fixture(name = randomUUID()) {
    const project = (
      await request(app.server)
        .post('/api/projects')
        .set(owner.headers)
        .send({ name })
        .expect(201)
    ).body.id as string;
    const binding = (
      await request(app.server)
        .post(url(project) + '/workflows')
        .set(owner.headers)
        .send({ name: 'Archive scan', jobs: { probe: { run: 'subfinder' } } })
        .expect(201)
    ).body as { id: string; workflowId: string };
    const asset = await insert(
      `INSERT INTO assets(value,"targetId","isPrimary") SELECT $1,id,true FROM targets WHERE id=$2`,
      [
        'archive.example.test',
        await insert(
          `INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2)`,
          [randomUUID() + '.example.test', owner.workspace.id],
        ),
      ],
    );
    await q('INSERT INTO project_assets("projectId","assetId") VALUES($1,$2)', [
      project,
      asset,
    ]);
    const trigger = (
      await request(app.server)
        .post(url(project) + '/triggers')
        .set(owner.headers)
        .send({
          projectWorkflowId: binding.id,
          type: 'cron',
          cron: '0 8 * * *',
        })
        .expect(201)
    ).body as { id: string };
    await request(app.server)
      .patch(url(project) + '/triggers/' + trigger.id)
      .set(owner.headers)
      .send({ enabled: true })
      .expect(200);
    return { project, binding, trigger, asset };
  }
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'archive-owner');
    other = await createUserWithWorkspace(app.server, 'archive-other');
    const member = await insert(
      'INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)',
      [owner.workspace.id, other.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions(name,permissions,"workspaceId") VALUES($1,$2,$3)',
      [randomUUID(), ['project.read'], owner.workspace.id],
    );
    await q(
      'INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)',
      [member, role],
    );
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

  it('archives/reopens idempotently, preserves data/preferences, stops and restores schedulers', async () => {
    const f = await fixture();
    await request(app.server)
      .patch('/api/asset-group/workflows/' + f.binding.id)
      .set(owner.headers)
      .send({ schedule: '0 9 * * *' })
      .expect(200);
    const run = (
      await request(app.server)
        .post(url(f.project) + '/workflows/' + f.binding.id + '/run')
        .set(owner.headers)
        .send({})
        .expect(201)
    ).body.jobHistoryId as string;
    const queue = app.app.get<Queue>(
      getQueueToken(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE),
    );
    const before = (await queue.getJobSchedulers()).filter(
      (s) => s.name === f.binding.id || s.key.includes(f.trigger.id),
    );
    expect(before).toHaveLength(2);
    const archived = await post(f.project.toUpperCase(), 'archive').expect(201);
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    expect((await post(f.project, 'archive').expect(201)).body.archivedAt).toBe(
      archived.body.archivedAt,
    );
    expect(
      (await request(app.server).get(url(f.project)).set(reader()).expect(200))
        .body.archivedAt,
    ).toBe(archived.body.archivedAt);
    expect(
      (await queue.getJobSchedulers()).filter(
        (s) => s.name === f.binding.id || s.key.includes(f.trigger.id),
      ),
    ).toHaveLength(0);
    expect(
      await q('SELECT enabled FROM project_workflow_triggers WHERE id=$1', [
        f.trigger.id,
      ]),
    ).toEqual([{ enabled: true }]);
    expect(
      await q('SELECT schedule FROM project_workflows WHERE id=$1', [
        f.binding.id,
      ]),
    ).toEqual([{ schedule: '0 9 * * *' }]);
    expect(
      await q('SELECT id FROM job_histories WHERE id=$1', [run]),
    ).toHaveLength(1);
    const reopened = await post(f.project, 'unarchive').expect(201);
    expect(reopened.body.archivedAt).toBeNull();
    await post(f.project, 'unarchive').expect(201);
    expect(
      (await queue.getJobSchedulers()).filter(
        (s) => s.name === f.binding.id || s.key.includes(f.trigger.id),
      ),
    ).toHaveLength(2);
    expect(
      await q('SELECT id FROM project_assets WHERE "projectId"=$1', [
        f.project,
      ]),
    ).toHaveLength(1);
  });
  it('scopes access, validates UUIDs and requires write permission for both operations', async () => {
    const f = await fixture();
    for (const action of ['archive', 'unarchive'] as const) {
      await post(f.project, action, reader()).expect(403);
      await post(f.project, action, other.headers).expect(404);
      await post(randomUUID(), action).expect(404);
      await post('invalid', action).expect(400);
    }
    await q('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [
      ['group.write'],
      role,
    ]);
    try {
      await post(f.project, 'archive', reader()).expect(201);
      await post(f.project, 'unarchive', reader()).expect(201);
    } finally {
      await q('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [
        ['project.read'],
        role,
      ]);
    }
  });
  it('filters canonical lists before pagination and keeps legacy list behavior', async () => {
    const prefix = 'Archive filter ' + randomUUID();
    const a = await fixture(prefix + ' A'),
      b = await fixture(prefix + ' B');
    await post(b.project, 'archive').expect(201);
    const list = (status?: string) =>
      request(app.server)
        .get('/api/projects')
        .set(owner.headers)
        .query({
          search: prefix,
          page: 1,
          limit: 1,
          sortBy: 'name',
          sortOrder: 'ASC',
          ...(status ? { status } : {}),
        });
    const active = await list().expect(200);
    expect(active.body.total).toBe(1);
    expect(active.body.data[0].id).toBe(a.project);
    expect(active.body.data[0].archivedAt).toBeNull();
    const archived = await list('archived').expect(200);
    expect(archived.body.total).toBe(1);
    expect(archived.body.data[0].id).toBe(b.project);
    expect((await list('all').expect(200)).body.total).toBe(2);
    await list('invalid').expect(400);
    expect(
      (
        await request(app.server)
          .get('/api/asset-group')
          .set(owner.headers)
          .query({ search: prefix })
          .expect(200)
      ).body.total,
    ).toBe(2);
  });
  it('rejects canonical, generic and legacy content mutations while retaining historical reads', async () => {
    const f = await fixture();
    await post(f.project, 'archive').expect(201);
    const cases: ['post' | 'patch' | 'delete', string, object][] = [
      ['patch', url(f.project), { name: 'Changed' }],
      ['patch', url(f.project), { description: 'Changed' }],
      ['patch', url(f.project), { autoAddAssets: false }],
      ['patch', url(f.project), { instruction: 'Changed' }],
      ['patch', '/api/asset-group/' + f.project, { name: 'Changed' }],
      [
        'post',
        url(f.project) + '/workflows',
        { jobs: { probe: { run: 'subfinder' } } },
      ],
      ['post', url(f.project) + '/workflows/' + f.binding.id + '/run', {}],
      ['post', '/api/asset-group/workflows/' + f.binding.id + '/run', {}],
      [
        'patch',
        '/api/asset-group/workflows/' + f.binding.id,
        { schedule: 'disabled' },
      ],
      [
        'patch',
        url(f.project) + '/workflows/' + f.binding.id,
        { name: 'Changed' },
      ],
      ['delete', url(f.project) + '/workflows/' + f.binding.id, {}],
      [
        'delete',
        '/api/asset-group/' + f.project + '/workflows',
        { workflowIds: [f.binding.workflowId] },
      ],
      [
        'post',
        '/api/asset-group/' + f.project + '/workflows',
        { workflowIds: [randomUUID()], schedule: 'disabled' },
      ],
      [
        'delete',
        '/api/asset-group/' + f.project + '/assets',
        { assetIds: [f.asset] },
      ],
      [
        'post',
        '/api/asset-group/' + f.project + '/assets',
        { assetIds: [f.asset] },
      ],
      ['patch', '/api/workflows/' + f.binding.workflowId, { name: 'Changed' }],
      ['delete', '/api/workflows/' + f.binding.workflowId, {}],
      [
        'patch',
        url(f.project) + '/triggers/' + f.trigger.id,
        { enabled: false },
      ],
      [
        'post',
        url(f.project) + '/files/presign',
        { fileName: 'scope.md', sizeBytes: 10 },
      ],
    ];
    for (const [method, path, body] of cases) {
      const result = await request(app.server)[method](path)
        .set(owner.headers)
        .send(body);
      if (result.status !== 400)
        throw new Error(
          `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`,
        );
    }
    for (const suffix of [
      '',
      '/workflows',
      '/triggers',
      '/assets',
      '/runs',
      '/files',
      '/overview',
    ])
      await request(app.server)
        .get(url(f.project) + suffix)
        .set(owner.headers)
        .expect(200);
    await post(f.project, 'unarchive').expect(201);
    await request(app.server)
      .patch(url(f.project))
      .set(owner.headers)
      .send({ name: 'Editable again' })
      .expect(200);
  });
  it('does not replay an old event window after a Redis cleanup failure across archive/reopen', async () => {
    const f = await fixture();
    const trigger = (
      await request(app.server)
        .post(url(f.project) + '/triggers')
        .set(owner.headers)
        .send({
          projectWorkflowId: f.binding.id,
          type: 'event',
          event: 'project.assets.added',
          config: { windowMinutes: 10 },
        })
        .expect(201)
    ).body as { id: string };
    await request(app.server)
      .patch(url(f.project) + '/triggers/' + trigger.id)
      .set(owner.headers)
      .send({ enabled: true })
      .expect(200);
    const batches = app.app.get(ProjectTriggerBatchService),
      runtime = app.app.get(ProjectTriggerRuntimeService),
      queue = app.app.get<Queue<ProjectTriggerEventJob>>(
        getQueueToken(BullMQName.PROJECT_TRIGGER_EVENTS),
      );
    await batches.gather(trigger.id, [f.asset], null, 10, randomUUID());
    const job = (await queue.getJobs(['delayed', 'waiting'])).find(
      (j) => j.data.triggerId === trigger.id,
    )!;
    expect(job).toBeTruthy();
    const spy = jest
      .spyOn(runtime, 'reconcile')
      .mockRejectedValue(new Error('Redis cleanup unavailable'));
    try {
      await post(f.project, 'archive').expect(201);
      await post(f.project, 'unarchive').expect(201);
    } finally {
      spy.mockRestore();
    }
    await runtime.fireEvent(job.data);
    expect(
      await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
        f.binding.id,
      ]),
    ).toHaveLength(0);
    await runtime.reconcile();
  });
  it('fences an event already drained into a replica before archive/reopen', async () => {
    const f = await fixture();
    const trigger = (
      await request(app.server)
        .post(url(f.project) + '/triggers')
        .set(owner.headers)
        .send({
          projectWorkflowId: f.binding.id,
          type: 'event',
          event: 'project.assets.added',
          config: { windowMinutes: 10 },
        })
        .expect(201)
    ).body as { id: string };
    await request(app.server)
      .patch(url(f.project) + '/triggers/' + trigger.id)
      .set(owner.headers)
      .send({ enabled: true })
      .expect(200);
    const batches = app.app.get(ProjectTriggerBatchService),
      runtime = app.app.get(ProjectTriggerRuntimeService),
      queue = app.app.get<Queue<ProjectTriggerEventJob>>(
        getQueueToken(BullMQName.PROJECT_TRIGGER_EVENTS),
      );
    await batches.gather(trigger.id, [f.asset], null, 10, randomUUID());
    const job = (await queue.getJobs(['delayed', 'waiting'])).find(
      (j) => j.data.triggerId === trigger.id,
    )!;
    const runner = app.app.get(WorkflowRunnerService),
      original = runner.startRun.bind(
        runner,
      ) as WorkflowRunnerService['startRun'];
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
    const spy = jest
      .spyOn(runner, 'startRun')
      .mockImplementation(async (input, validate) => {
        reached();
        await resumed;
        return original(input, validate);
      });
    const pending = runtime.fireEvent(job.data);
    try {
      await entered;
      await post(f.project, 'archive').expect(201);
      await post(f.project, 'unarchive').expect(201);
      release();
      await pending;
      expect(
        await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
          f.binding.id,
        ]),
      ).toHaveLength(0);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it('restores a legacy scheduler before deduplicating an identical trigger schedule', async () => {
    const f = await fixture();
    await request(app.server)
      .patch('/api/asset-group/workflows/' + f.binding.id)
      .set(owner.headers)
      .send({ schedule: '0 8 * * *' })
      .expect(200);
    await post(f.project, 'archive').expect(201);
    const legacy = app.app.get(ProjectLegacyScheduleService),
      runtime = app.app.get(ProjectTriggerRuntimeService);
    const original = legacy.reconcile.bind(
      legacy,
    ) as ProjectLegacyScheduleService['reconcile'];
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      resume = new Promise<void>((resolve) => {
        release = resolve;
      });
    const slow = jest
      .spyOn(legacy, 'reconcile')
      .mockImplementation(async (...args) => {
        reached();
        await resume;
        return original(...args);
      });
    const reconcile = jest.spyOn(runtime, 'reconcile');
    const pending = post(f.project, 'unarchive').then((result) => result);
    try {
      await entered;
      expect(reconcile).not.toHaveBeenCalled();
      release();
      expect((await pending).status).toBe(201);
      const queue = app.app.get<Queue>(
        getQueueToken(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE),
      );
      expect(
        (await queue.getJobSchedulers()).filter(
          (s) => s.name === f.binding.id || s.key.includes(f.trigger.id),
        ),
      ).toHaveLength(1);
    } finally {
      release();
      await pending;
      slow.mockRestore();
      reconcile.mockRestore();
    }
  });
  it('invalidates the old legacy delivery key even if Redis stays down across archive/reopen', async () => {
    const f = await fixture();
    await request(app.server)
      .patch('/api/asset-group/workflows/' + f.binding.id)
      .set(owner.headers)
      .send({ schedule: '0 9 * * *' })
      .expect(200);
    const [binding] = await q(
      'SELECT "jobId" FROM project_workflows WHERE id=$1',
      [f.binding.id],
    );
    const legacy = app.app.get(ProjectLegacyScheduleService),
      service = app.app.get(AssetGroupWorkflowService);
    const failed = jest
      .spyOn(legacy, 'reconcile')
      .mockRejectedValue(new Error('Redis unavailable'));
    const cleanup = jest
      .spyOn(legacy, 'remove')
      .mockRejectedValue(new Error('Redis unavailable'));
    try {
      await post(f.project, 'archive').expect(201);
      await post(f.project, 'unarchive').expect(201);
      await expect(
        service.runGroupWorkflowScheduler(
          f.binding.id,
          JobRunType.SCHEDULED,
          owner.workspace.id,
          binding.jobId as string,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
          f.binding.id,
        ]),
      ).toHaveLength(0);
    } finally {
      failed.mockRestore();
      cleanup.mockRestore();
    }
  });
  it('keeps a stale gather from mixing assets into the new generation window', async () => {
    const f = await fixture();
    const trigger = (
      await request(app.server)
        .post(url(f.project) + '/triggers')
        .set(owner.headers)
        .send({
          projectWorkflowId: f.binding.id,
          type: 'event',
          event: 'project.assets.added',
          config: { windowMinutes: 10 },
        })
        .expect(201)
    ).body as { id: string };
    await request(app.server)
      .patch(url(f.project) + '/triggers/' + trigger.id)
      .set(owner.headers)
      .send({ enabled: true })
      .expect(200);
    await post(f.project, 'archive').expect(201);
    await post(f.project, 'unarchive').expect(201);
    const extra = await insert(
      'INSERT INTO assets(value,"targetId","isPrimary") SELECT $1,"targetId",false FROM assets WHERE id=$2',
      ['new.archive.example.test', f.asset],
    );
    await q('INSERT INTO project_assets("projectId","assetId") VALUES($1,$2)', [
      f.project,
      extra,
    ]);
    const [row] = await q(
      'SELECT "schedulerId" FROM project_workflow_triggers WHERE id=$1',
      [trigger.id],
    );
    const epoch = triggerEpoch(row.schedulerId as string);
    const batches = app.app.get(ProjectTriggerBatchService),
      runtime = app.app.get(ProjectTriggerRuntimeService),
      queue = app.app.get<Queue<ProjectTriggerEventJob>>(
        getQueueToken(BullMQName.PROJECT_TRIGGER_EVENTS),
      );
    await batches.gather(trigger.id, [extra], null, 10, randomUUID(), epoch);
    // A replica loaded before archive resumes its old gather afterwards.
    await batches.gather(trigger.id, [f.asset], null, 10, randomUUID());
    const job = (await queue.getJobs(['delayed', 'waiting'])).find(
      (j) => j.data.triggerId === trigger.id && j.data.epoch === epoch,
    )!;
    await runtime.fireEvent(job.data);
    const runs = await q(
      'SELECT scope FROM job_histories WHERE "projectWorkflowId"=$1',
      [f.binding.id],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].scope).toEqual({ assetIds: [extra] });
  });
  it('ignores a source-stream event produced before archive and first consumed after reopen', async () => {
    const f = await fixture();
    const trigger = (
      await request(app.server)
        .post(url(f.project) + '/triggers')
        .set(owner.headers)
        .send({
          projectWorkflowId: f.binding.id,
          type: 'event',
          event: 'project.assets.added',
          config: { windowMinutes: 10 },
        })
        .expect(201)
    ).body as { id: string };
    await request(app.server)
      .patch(url(f.project) + '/triggers/' + trigger.id)
      .set(owner.headers)
      .send({ enabled: true })
      .expect(200);
    const event = {
      eventId: randomUUID(),
      workspaceId: owner.workspace.id,
      occurredAt: '2020-01-01T00:00:00.000Z',
      payload: { projectId: f.project, assetIds: [f.asset] },
    } as ConsumedEvent;
    await post(f.project, 'archive').expect(201);
    await post(f.project, 'unarchive').expect(201);
    const runtime = app.app.get(ProjectTriggerRuntimeService),
      queue = app.app.get<Queue<ProjectTriggerEventJob>>(
        getQueueToken(BullMQName.PROJECT_TRIGGER_EVENTS),
      );
    await runtime.handleEvent('project.assets.added', event);
    expect(
      (await queue.getJobs(['delayed', 'waiting'])).filter(
        (job) => job.data.triggerId === trigger.id,
      ),
    ).toHaveLength(0);
    await runtime.handleEvent('project.assets.added', {
      ...event,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });
    const job = (await queue.getJobs(['delayed', 'waiting'])).find(
      (job) => job.data.triggerId === trigger.id,
    )!;
    expect(job).toBeTruthy();
    await runtime.fireEvent(job.data);
    expect(
      await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
        f.binding.id,
      ]),
    ).toHaveLength(1);
  });
  it('does not overwrite a committed archive marker from an older reconciler snapshot', async () => {
    const f = await fixture();
    const runtime = app.app.get(ProjectTriggerRuntimeService),
      original = runtime.reconcile.bind(
        runtime,
      ) as ProjectTriggerRuntimeService['reconcile'];
    const queue = (runtime as unknown as { schedules: Queue }).schedules,
      getSchedulers = queue.getJobSchedulers.bind(
        queue,
      ) as Queue['getJobSchedulers'];
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
    const paused = jest
      .spyOn(queue, 'getJobSchedulers')
      .mockImplementationOnce(async (...args) => {
        reached();
        await resumed;
        return getSchedulers(...args);
      });
    // Isolate the trigger snapshot CAS from the coordinated legacy row locks.
    const skipCoordinated = jest
      .spyOn(app.app.get(ProjectLegacyScheduleService), 'reconcileWithManager')
      .mockResolvedValue(undefined);
    const reconciler = original();
    await entered;
    const skip = jest.spyOn(runtime, 'reconcile').mockResolvedValue(undefined);
    const skipLegacy = jest
      .spyOn(app.app.get(ProjectLegacyScheduleService), 'reconcile')
      .mockResolvedValue(undefined);
    try {
      await post(f.project, 'archive').expect(201);
      await post(f.project, 'unarchive').expect(201);
      const [before] = await q(
        'SELECT "schedulerId" FROM project_workflow_triggers WHERE id=$1',
        [f.trigger.id],
      );
      release();
      await reconciler;
      expect(
        await q(
          'SELECT "schedulerId" FROM project_workflow_triggers WHERE id=$1',
          [f.trigger.id],
        ),
      ).toEqual([before]);
    } finally {
      release();
      await reconciler;
      skip.mockRestore();
      skipLegacy.mockRestore();
      skipCoordinated.mockRestore();
      paused.mockRestore();
      await runtime.reconcile();
    }
  });
  it('coordinates concurrent recovery so an equal legacy and trigger cron restores one scheduler', async () => {
    const f = await fixture();
    await request(app.server)
      .patch('/api/asset-group/workflows/' + f.binding.id)
      .set(owner.headers)
      .send({ schedule: '0 8 * * *' })
      .expect(200);
    await post(f.project, 'archive').expect(201);
    const legacy = app.app.get(ProjectLegacyScheduleService),
      runtime = app.app.get(ProjectTriggerRuntimeService);
    const a = jest
      .spyOn(legacy, 'reconcile')
      .mockRejectedValue(new Error('offline'));
    const b = jest
      .spyOn(runtime, 'reconcile')
      .mockRejectedValue(new Error('offline'));
    try {
      await post(f.project, 'unarchive').expect(201);
    } finally {
      a.mockRestore();
      b.mockRestore();
    }
    await Promise.all([legacy.reconcile(), runtime.reconcile()]);
    const queue = app.app.get<Queue>(
      getQueueToken(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE),
    );
    expect(
      (await queue.getJobSchedulers()).filter(
        (row) => row.name === f.binding.id || row.key.includes(f.trigger.id),
      ),
    ).toHaveLength(1);
  });
  it('serializes legacy scheduler publication with archive and rejects its old delivery after reopen', async () => {
    const f = await fixture();
    await q(
      'UPDATE project_workflows SET schedule=$1,"jobId"=NULL WHERE id=$2',
      ['0 9 * * *', f.binding.id],
    );
    const legacy = app.app.get(ProjectLegacyScheduleService),
      runtime = app.app.get(ProjectTriggerRuntimeService);
    const queue = (legacy as unknown as { queue: Queue }).queue;
    const original = queue.upsertJobScheduler.bind(
      queue,
    ) as Queue['upsertJobScheduler'];
    let reached!: () => void,
      release!: () => void,
      staleKey = '';
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      resume = new Promise<void>((resolve) => {
        release = resolve;
      });
    const paused = jest
      .spyOn(queue, 'upsertJobScheduler')
      .mockImplementationOnce(async (...args) => {
        staleKey = args[0];
        const result = await original(...args);
        reached();
        await resume;
        return result;
      });
    const pending = legacy.reconcile(f.project, owner.workspace.id);
    await entered;
    const skipLegacy = jest
        .spyOn(legacy, 'reconcile')
        .mockResolvedValue(undefined),
      skipRuntime = jest
        .spyOn(runtime, 'reconcile')
        .mockResolvedValue(undefined);
    try {
      const archiveRequest = post(f.project, 'archive').then(
        (result) => result,
      );
      release();
      await pending;
      expect((await archiveRequest).status).toBe(201);
      await post(f.project, 'unarchive').expect(201);
      const service = app.app.get(AssetGroupWorkflowService);
      await expect(
        service.runGroupWorkflowScheduler(
          f.binding.id,
          JobRunType.SCHEDULED,
          owner.workspace.id,
          staleKey,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
          f.binding.id,
        ]),
      ).toHaveLength(0);
    } finally {
      release();
      await pending;
      paused.mockRestore();
      skipLegacy.mockRestore();
      skipRuntime.mockRestore();
      await runtime.reconcile();
    }
  });

  it('waits for a newly published legacy key to commit before delivering its first run', async () => {
    const f = await fixture();
    await q(
      'UPDATE project_workflows SET schedule=$1,"jobId"=NULL WHERE id=$2',
      ['0 9 * * *', f.binding.id],
    );
    const legacy = app.app.get(ProjectLegacyScheduleService),
      service = app.app.get(AssetGroupWorkflowService);
    const queue = (legacy as unknown as { queue: Queue }).queue;
    const original = queue.upsertJobScheduler.bind(
      queue,
    ) as Queue['upsertJobScheduler'];
    let reached!: () => void,
      release!: () => void,
      key = '';
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      resume = new Promise<void>((resolve) => {
        release = resolve;
      });
    const paused = jest
      .spyOn(queue, 'upsertJobScheduler')
      .mockImplementationOnce(async (...args) => {
        key = args[0];
        const result = await original(...args);
        reached();
        await resume;
        return result;
      });
    const repair = legacy.reconcile(f.project, owner.workspace.id);
    await entered;
    const runner = app.app.get(WorkflowRunnerService),
      start = runner.startRun.bind(runner) as WorkflowRunnerService['startRun'];
    let signal!: () => void;
    const launching = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const spy = jest
      .spyOn(runner, 'startRun')
      .mockImplementation((input, validate) => {
        signal();
        return start(input, validate);
      });
    const delivery = service.runGroupWorkflowScheduler(
      f.binding.id,
      JobRunType.SCHEDULED,
      owner.workspace.id,
      key,
    );
    try {
      await launching;
      release();
      await repair;
      await delivery;
      expect(await queue.getJobScheduler(key)).toBeTruthy();
      expect(
        await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
          f.binding.id,
        ]),
      ).toHaveLength(1);
    } finally {
      release();
      await repair;
      spy.mockRestore();
      paused.mockRestore();
    }
  });
});
