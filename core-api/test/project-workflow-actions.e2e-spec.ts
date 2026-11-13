import { randomUUID } from 'node:crypto';
import { WorkflowRunnerService } from '@/modules/jobs-registry/workflow-runner.service';
import { getQueueToken } from '@nestjs/bullmq';
import { BullMQName } from '@/common/enums/enum';
import type { Queue } from 'bullmq';
import { AssetGroupWorkflowService } from '@/modules/asset-group/asset-group-workflow.service';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project workflow actions (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let project: string;
  let role: string;
  let assets: string[];
  const q = async (sql: string, args: unknown[] = []) =>
    app.dataSource.query<Record<string, unknown>[]>(sql, args);
  const insert = async (sql: string, args: unknown[]) =>
    (await q(sql + ' RETURNING id', args))[0].id as string;
  const url = (binding?: string) =>
    `/api/projects/${project}/workflows${binding ? '/' + binding : ''}`;
  const reader = () => ({
    ...other.headers,
    'X-Workspace-Id': owner.workspace.id,
  });
  const fixture = async () =>
    (
      await request(app.server)
        .post(url())
        .set(owner.headers)
        .send({ name: 'Actions scan', jobs: { probe: { run: 'subfinder' } } })
        .expect(201)
    ).body as { id: string; workflowId: string };

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'workflow-actions-owner');
    other = await createUserWithWorkspace(app.server, 'workflow-actions-other');
    project = (
      await request(app.server)
        .post('/api/projects')
        .set(owner.headers)
        .send({ name: 'Actions project' })
        .expect(201)
    ).body.id;
    assets = [];
    for (const enabled of [true, true, false]) {
      const target = await insert(
        'INSERT INTO targets(value,type,"workspaceId") VALUES($1,$2,$3)',
        [randomUUID() + '.example.test', 'DOMAIN', owner.workspace.id],
      );
      const asset = await insert(
        'INSERT INTO assets(value,"targetId","isPrimary","isEnabled") VALUES($1,$2,true,$3)',
        [randomUUID() + '.example.test', target, enabled],
      );
      await q(
        'INSERT INTO project_assets("projectId","assetId") VALUES($1,$2)',
        [project, asset],
      );
      assets.push(asset);
    }
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

  it('lists safe bindings and recognized triggers without scheduler identifiers or configuration secrets', async () => {
    const f = await fixture();
    await q('UPDATE workflows SET content=$1 WHERE id=$2', [
      JSON.stringify({
        name: 'Actions scan',
        jobs: {
          probe: {
            run: 'httpx',
            config: { apiKey: 'top-secret', username: 'public' },
          },
        },
      }),
      f.workflowId,
    ]);
    await request(app.server)
      .post(`/api/projects/${project}/triggers`)
      .set(owner.headers)
      .send({ projectWorkflowId: f.id, type: 'cron', cron: '0 8 * * *' })
      .expect(201);
    const { body } = await request(app.server)
      .get(url())
      .set(reader())
      .expect(200);
    const row = body.find((v: { id: string }) => v.id === f.id);
    expect(row).toMatchObject({
      projectId: project,
      workflowId: f.workflowId,
      schedule: 'disabled',
      lastRun: null,
      triggers: [{ type: 'cron', enabled: false }],
    });
    expect(row.workflow.content.jobs.probe.config).toMatchObject({
      apiKey: expect.stringMatching(/^\*+/),
      username: 'public',
    });
    expect(JSON.stringify(row)).not.toMatch(
      /top-secret|schedulerId|jobId|workspaceId|createdBy/,
    );
    await request(app.server).get(url()).set(other.headers).expect(404);
  });
  it('launches all enabled assets and a selected subset with durable project provenance', async () => {
    const f = await fixture();
    for (const [body, expected] of [
      [{}, assets.slice(0, 2)],
      [{ assetIds: [assets[1]] }, [assets[1]]],
    ] as const) {
      const result = await request(app.server)
        .post(url(f.id) + '/run')
        .set(owner.headers)
        .send(body)
        .expect(201);
      expect(result.body).toEqual({
        jobHistoryId: expect.any(String),
        assets: expected.length,
      });
      const [run] = await q(
        'SELECT scope,"projectId","projectWorkflowId" FROM job_histories WHERE id=$1',
        [result.body.jobHistoryId],
      );
      expect(run).toMatchObject({
        projectId: project,
        projectWorkflowId: f.id,
        scope: { assetIds: [...expected].sort() },
      });
    }
    const { body } = await request(app.server)
      .get(url())
      .set(owner.headers)
      .expect(200);
    expect(
      body.find((v: { id: string }) => v.id === f.id).lastRun.id,
    ).toBeTruthy();
    const restricted = await request(app.server)
      .get(url())
      .set(reader())
      .expect(200);
    expect(
      restricted.body.every((v: { lastRun: unknown }) => v.lastRun === null),
    ).toBe(true);
  });
  it('rejects invalid, disabled and foreign asset selections before creating a run', async () => {
    const f = await fixture();
    for (const assetIds of [
      [],
      [assets[0], assets[0]],
      [assets[2]],
      [randomUUID()],
      ['invalid'],
      Array.from({ length: 5001 }, () => randomUUID()),
    ]) {
      await request(app.server)
        .post(url(f.id) + '/run')
        .set(owner.headers)
        .send({ assetIds })
        .expect(400);
    }
    expect(
      await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
        f.id,
      ]),
    ).toHaveLength(0);
    await request(app.server)
      .post(url(randomUUID()) + '/run')
      .set(owner.headers)
      .send({})
      .expect(404);
  });
  it('requires both project and workflow write permission for launch', async () => {
    const f = await fixture();
    for (const permissions of [
      ['project.read'],
      ['project.write'],
      ['workflow.write'],
    ]) {
      await q('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [
        permissions,
        role,
      ]);
      await request(app.server)
        .post(url(f.id) + '/run')
        .set(reader())
        .send({})
        .expect(403);
    }
    await q('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [
      ['project.read'],
      role,
    ]);
    await request(app.server).delete(url(f.id)).set(reader()).expect(403);
  });
  it('removes an exclusive owned definition and its runs while retaining shared definitions', async () => {
    const f = await fixture();
    const run = await request(app.server)
      .post(url(f.id) + '/run')
      .set(owner.headers)
      .send({})
      .expect(201);
    const finding = await insert(
      'INSERT INTO vulnerabilities(name,fingerprint,"assetId","jobHistoryId","lastSeenJobHistoryId","fixedByJobHistoryId") VALUES($1,$2,$3,$4,$4,$4)',
      [
        'Preserved action finding',
        randomUUID(),
        assets[0],
        run.body.jobHistoryId,
      ],
    );
    await request(app.server)
      .post(`/api/projects/${project}/triggers`)
      .set(owner.headers)
      .send({ projectWorkflowId: f.id, type: 'cron', cron: '0 8 * * *' })
      .expect(201);
    const queue = app.app.get<Queue>(
      getQueueToken(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE),
    );
    const scheduler = await queue.add(
      f.id,
      { id: f.id },
      { repeat: { pattern: '0 8 * * *' } },
    );
    await q('UPDATE project_workflows SET "jobId"=$1 WHERE id=$2', [
      scheduler.repeatJobKey,
      f.id,
    ]);
    await request(app.server)
      .delete(url(f.id.toUpperCase()).replace(project, project.toUpperCase()))
      .set(owner.headers)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          name: 'Actions scan',
          message: expect.any(String),
        }),
      );
    expect(
      await q('SELECT id FROM workflows WHERE id=$1', [f.workflowId]),
    ).toHaveLength(0);
    expect(
      await q('SELECT id FROM job_histories WHERE "workflowId"=$1', [
        f.workflowId,
      ]),
    ).toHaveLength(0);
    expect(
      await q(
        'SELECT "jobHistoryId","lastSeenJobHistoryId","fixedByJobHistoryId" FROM vulnerabilities WHERE id=$1',
        [finding],
      ),
    ).toEqual([
      {
        jobHistoryId: null,
        lastSeenJobHistoryId: null,
        fixedByJobHistoryId: null,
      },
    ]);
    expect(
      await q(
        'SELECT id FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
        [f.id],
      ),
    ).toHaveLength(0);
    expect(await queue.getJobScheduler(scheduler.repeatJobKey!)).toBeFalsy();
    const shared = await fixture();
    await q('UPDATE workflows SET "filePath"=$1 WHERE id=$2', [
      'library-' + randomUUID() + '.yaml',
      shared.workflowId,
    ]);
    await request(app.server)
      .post(url(shared.id) + '/run')
      .set(owner.headers)
      .send({})
      .expect(201);
    await request(app.server)
      .delete(url(shared.id))
      .set(owner.headers)
      .expect(200);
    expect(
      await q('SELECT id FROM workflows WHERE id=$1', [shared.workflowId]),
    ).toHaveLength(1);
    await request(app.server)
      .delete(url(shared.id))
      .set(owner.headers)
      .expect(404);
  });
  it('keeps an owned definition when another project still references it', async () => {
    const f = await fixture();
    const second = await insert(
      'INSERT INTO projects(name,"workspaceId") VALUES($1,$2)',
      ['Reuses workflow', owner.workspace.id],
    );
    const binding = await insert(
      'INSERT INTO project_workflows("projectId","workflowId") VALUES($1,$2)',
      [second, f.workflowId],
    );
    await request(app.server).delete(url(f.id)).set(owner.headers).expect(200);
    expect(
      await q('SELECT id FROM workflows WHERE id=$1', [f.workflowId]),
    ).toHaveLength(1);
    expect(
      await q('SELECT id FROM project_workflows WHERE id=$1', [binding]),
    ).toHaveLength(1);
  });
  it('does not resurrect a removed shared binding after a late legacy schedule write', async () => {
    const f = await fixture();
    await q('UPDATE workflows SET "filePath"=$1 WHERE id=$2', [
      'library-' + randomUUID() + '.yaml',
      f.workflowId,
    ]);
    const legacy = app.app.get(AssetGroupWorkflowService);
    // Pause only the existing service's Redis boundary, leaving real DB transactions active.
    const queue = (legacy as unknown as { scanScheduleQueue: Queue })
      .scanScheduleQueue;
    const original = queue.add.bind(queue) as Queue['add'];
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest.spyOn(queue, 'add').mockImplementation(async (...args) => {
      reached();
      await resume;
      return original(...args);
    });
    const pending = request(app.server)
      .patch('/api/asset-group/workflows/' + f.id)
      .set(owner.headers)
      .send({ schedule: '0 9 * * *' })
      .then((result) => result);
    try {
      await entered;
      await request(app.server)
        .delete(url(f.id))
        .set(owner.headers)
        .expect(200);
      release();
      expect((await pending).status).toBe(404);
      expect(
        await q('SELECT id FROM project_workflows WHERE id=$1', [f.id]),
      ).toHaveLength(0);
      expect(
        (await queue.getJobSchedulers()).filter((row) => row.name === f.id),
      ).toHaveLength(0);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it.each(['scope', 'revision'])(
    'revalidates a concurrent %s change after waiting for launch locks',
    async (change) => {
      const f = await fixture();
      const transaction = app.dataSource.createQueryRunner();
      await transaction.connect();
      await transaction.startTransaction();
      await transaction.manager.query(
        'SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE',
        [project],
      );
      const runner = app.app.get(WorkflowRunnerService),
        original = runner.startRun.bind(runner) as WorkflowRunnerService['startRun'];
      let signal!: () => void;
      const reached = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const spy = jest
        .spyOn(runner, 'startRun')
        .mockImplementation((input, validate) => {
          signal();
          return original(input, validate);
        });
      const pending = request(app.server)
        .post(url(f.id) + '/run')
        .set(owner.headers)
        .send({ assetIds: [assets[0]] })
        .then((result) => result);
      try {
        await reached;
        if (change === 'scope')
          await transaction.manager.query(
            'DELETE FROM project_assets WHERE "projectId"=$1 AND "assetId"=$2',
            [project, assets[0]],
          );
        else
          await transaction.manager.query(
            "UPDATE workflows SET content=jsonb_set(content,'{jobs,probe,name}','\"Changed under the same timestamp\"') WHERE id=$1",
            [f.workflowId],
          );
        await transaction.commitTransaction();
        expect((await pending).status).toBe(400);
        expect(
          await q('SELECT id FROM job_histories WHERE "projectWorkflowId"=$1', [
            f.id,
          ]),
        ).toHaveLength(0);
      } finally {
        spy.mockRestore();
        if (transaction.isTransactionActive)
          await transaction.rollbackTransaction();
        await transaction.release();
        if (change === 'scope')
          await q(
            'INSERT INTO project_assets("projectId","assetId") VALUES($1,$2) ON CONFLICT DO NOTHING',
            [project, assets[0]],
          );
      }
    },
  );
  it('keeps archived projects readable and rejects launch and removal', async () => {
    const f = await fixture();
    await q('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [project]);
    try {
      await request(app.server).get(url()).set(owner.headers).expect(200);
      await request(app.server)
        .post(url(f.id) + '/run')
        .set(owner.headers)
        .send({})
        .expect(400);
      await request(app.server)
        .delete(url(f.id))
        .set(owner.headers)
        .expect(400);
    } finally {
      await q('UPDATE projects SET "archivedAt"=NULL WHERE id=$1', [project]);
    }
  });
});
