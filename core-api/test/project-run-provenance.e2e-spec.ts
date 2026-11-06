// Initialise the AppModule graph before feature imports with circular DI metadata.
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { JobRunType } from '@/common/enums/enum';
import { AssetGroupWorkflowService } from '@/modules/asset-group/asset-group-workflow.service';
import { JobHistory } from '@/modules/jobs-registry/entities/job-history.entity';
import { AssetGroupsScheduleConsumer } from '@/modules/jobs-registry/processors/scan-schedule.processor';
import { WorkflowRunnerService } from '@/modules/jobs-registry/workflow-runner.service';
import { Workflow } from '@/modules/workflows/entities/workflow.entity';
import type { Job } from 'bullmq';
import * as request from 'supertest';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

/** Exercise real run persistence without workers or live HTTP-service inputs. */
describe('New group run provenance (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let workflow: Workflow;
  let targetId: string;
  let assetId: string;
  const projects: string[] = [];
  const bindings: string[] = [];
  const insert = async (sql: string, values: unknown[]): Promise<string> => {
    const [row]: { id: string }[] = await app.dataSource.query(
      sql + ' RETURNING id',
      values,
    );
    return row.id;
  };
  const latestRun = async (): Promise<
    JobHistory & { projectId: string | null; projectWorkflowId: string | null }
  > => {
    const [row]: JobHistory[] = await app.dataSource.query(
      `SELECT * FROM job_histories WHERE "workflowId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [workflow.id],
    );
    return row;
  };

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'run-provenance-owner');
    other = await createUserWithWorkspace(app.server, 'run-provenance-other');
    targetId = await insert(
      `INSERT INTO targets (value, "workspaceId", type) VALUES ($1, $2, 'DOMAIN')`,
      ['run-provenance.example.com', owner.workspace.id],
    );
    assetId = await insert(
      `INSERT INTO assets (value, "targetId") VALUES ($1, $2)`,
      ['run-provenance.example.com', targetId],
    );
    workflow = await app.dataSource.getRepository(Workflow).save({
      name: 'Argus shared provenance workflow',
      filePath: 'argus-run-provenance.yaml',
      content: {
        name: 'Argus shared provenance workflow',
        on: {},
        jobs: { probe: { run: 'httpx' } },
      },
      workspace: { id: owner.workspace.id },
    });
    await app.dataSource.query(
      `INSERT INTO workspace_tools ("workspaceId", "toolId") SELECT $1, id FROM tools WHERE name = 'httpx'`,
      [owner.workspace.id],
    );
    for (const name of ['Argus first project', 'Argus second project']) {
      const id = await insert(
        `INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)`,
        [name, owner.workspace.id],
      );
      projects.push(id);
      await app.dataSource.query(
        `INSERT INTO project_assets ("projectId", "assetId") VALUES ($1, $2)`,
        [id, assetId],
      );
      bindings.push(
        await insert(
          `INSERT INTO project_workflows ("projectId", "workflowId") VALUES ($1, $2)`,
          [id, workflow.id],
        ),
      );
    }
  });

  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it.each([JobRunType.MANUAL, JobRunType.SCHEDULED])(
    'attributes a %s run to its exact shared-workflow binding',
    async (jobRunType) => {
      const index = jobRunType === JobRunType.MANUAL ? 0 : 1;
      if (jobRunType === JobRunType.MANUAL) {
        const response = await request(app.server)
          .post(`/api/asset-group/workflows/${bindings[index]}/run`)
          .set(owner.headers)
          .expect(201);
        expect(response.body).toEqual({
          message: `Run scheduler for asset group workflow with ID ${bindings[index]}`,
        });
      } else {
        const remove = jest.fn();
        await app.app
          .get(AssetGroupsScheduleConsumer)
          .process({ data: { id: bindings[index] }, remove } as unknown as Job);
        expect(remove).not.toHaveBeenCalled();
      }
      const run = await latestRun();
      expect(run).toMatchObject({
        projectId: projects[index],
        projectWorkflowId: bindings[index],
        jobRunType,
        scope: { assetIds: [assetId] },
        isCompleted: true,
      });
      expect(run.steps.probe).toMatchObject({
        status: 'skipped',
        reason: 'no-inputs',
      });
      const detail = await request(app.server)
        .get(`/api/jobs-registry/histories/${run.id}`)
        .set(owner.headers)
        .expect(200);
      expect(JSON.stringify(detail.body)).not.toMatch(
        /"project(?:Workflow)?Id"/,
      );
      const entity = await app.dataSource
        .getRepository(JobHistory)
        .findOneByOrFail({ id: run.id });
      expect(JSON.parse(JSON.stringify(entity))).not.toHaveProperty(
        'projectId',
      );
      expect(JSON.parse(JSON.stringify(entity))).not.toHaveProperty(
        'projectWorkflowId',
      );
    },
  );

  it('resolves the scheduler workspace through the persisted binding relations', async () => {
    await expect(
      app.app.get(AssetGroupWorkflowService).getBindingWorkspace(bindings[1]),
    ).resolves.toBe(owner.workspace.id);
  });

  it('keeps identity after a project rename without attributing standalone target runs', async () => {
    await request(app.server)
      .patch(`/api/asset-group/${projects[0]}`)
      .set(owner.headers)
      .send({ name: 'Argus renamed project' })
      .expect(200);
    await request(app.server)
      .post(`/api/asset-group/workflows/${bindings[0]}/run`)
      .set(owner.headers)
      .expect(201);
    expect(await latestRun()).toMatchObject({
      projectId: projects[0],
      projectWorkflowId: bindings[0],
      jobHistoryName: 'Argus renamed project',
    });
    await app.app
      .get(WorkflowRunnerService)
      .startRun({
        workflow,
        workspaceId: owner.workspace.id,
        jobName: 'Argus renamed project',
        targetIds: [targetId],
      });
    expect(await latestRun()).toMatchObject({
      projectId: null,
      projectWorkflowId: null,
      scope: { targetIds: [targetId] },
    });
  });

  it('rejects foreign requests and legacy bindings whose project belongs to another workspace', async () => {
    const url = `/api/asset-group/workflows/${bindings[0]}/run`;
    await request(app.server)
      .post(url)
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
    await request(app.server).post(url).set(other.headers).expect(404);
    await request(app.server)
      .post(url)
      .set(other.headers)
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(403);
    const foreignProject = await insert(
      `INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)`,
      ['Argus foreign legacy project', other.workspace.id],
    );
    await app.dataSource.query(
      `INSERT INTO project_assets ("projectId", "assetId") VALUES ($1, $2)`,
      [foreignProject, assetId],
    );
    const binding = await insert(
      `INSERT INTO project_workflows ("projectId", "workflowId") VALUES ($1, $2)`,
      [foreignProject, workflow.id],
    );
    const before = await app.dataSource.getRepository(JobHistory).count();
    await request(app.server)
      .post(`/api/asset-group/workflows/${binding}/run`)
      .set(owner.headers)
      .expect(404);
    expect(await app.dataSource.getRepository(JobHistory).count()).toBe(before);
  });

  it('creates no scanner jobs or finding links for these no-input runs', async () => {
    expect(
      await app.dataSource.query(
        `SELECT job.id FROM jobs job JOIN job_histories history ON history.id = job."jobHistoryId" WHERE history."workflowId" = $1`,
        [workflow.id],
      ),
    ).toEqual([]);
    expect(
      await app.dataSource.query(
        `SELECT id FROM project_vulnerabilities WHERE "projectId" = ANY($1::uuid[])`,
        [projects],
      ),
    ).toEqual([]);
  });
});
