import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { Workflow } from '@/modules/workflows/entities/workflow.entity';
import { WorkflowRunnerService } from '@/modules/jobs-registry/workflow-runner.service';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

/** Exercise legacy Groups contracts against real persistence, before and after renaming. */
describe('Asset group persistence compatibility (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let groupId: string;
  let bindingId: string;
  let included: string;
  let available: string;
  let foreign: string;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'group-storage');
    other = await createUserWithWorkspace(app.server, 'group-other');
    const seedAsset = async (
      workspaceId: string,
      name: string,
    ): Promise<string> => {
      const [target]: { id: string }[] = await app.dataSource.query(
        `INSERT INTO targets (value, "workspaceId", type) VALUES ($1, $2, 'DOMAIN') RETURNING id`,
        [name, workspaceId],
      );
      const [asset]: { id: string }[] = await app.dataSource.query(
        `INSERT INTO assets (value, "targetId") VALUES ($1, $2) RETURNING id`,
        [name, target.id],
      );
      return asset.id;
    };
    included = await seedAsset(owner.workspace.id, 'included.example.com');
    available = await seedAsset(owner.workspace.id, 'available.example.com');
    foreign = await seedAsset(other.workspace.id, 'foreign.example.com');
    const created = await request(app.server)
      .post('/api/asset-group')
      .set(owner.headers)
      .send({ name: 'Persistence fixture', hostIds: [included] })
      .expect(201);
    groupId = created.body.id as string;
    const workflow = await app.dataSource.getRepository(Workflow).save({
      name: 'Persistence workflow',
      filePath: 'persistence.yaml',
      content: { name: 'Persistence workflow', on: {}, jobs: {} },
      workspace: { id: owner.workspace.id },
    });
    await request(app.server)
      .post(`/api/asset-group/${groupId}/workflows`)
      .set(owner.headers)
      .send({ workflowIds: [workflow.id] })
      .expect(201);
    bindingId = (
      await app.dataSource
        .getRepository(AssetGroupWorkflow)
        .findOneByOrFail({ assetGroupId: groupId, workflowId: workflow.id })
    ).id;
  });

  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('keeps list counts, detail relations and legacy JSON property names', async () => {
    const list = await request(app.server)
      .get('/api/asset-group')
      .set(owner.headers)
      .expect(200);
    expect(list.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: groupId, totalAssets: 1 }),
      ]),
    );
    const detail = await request(app.server)
      .get(`/api/asset-group/${groupId}`)
      .set(owner.headers)
      .expect(200);
    expect(detail.body.id).toBe(groupId);
    expect(detail.body.assetGroupWorkflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: bindingId, assetGroupId: groupId }),
      ]),
    );
    expect(detail.body.assetGroupWorkflows[0]).not.toHaveProperty('projectId');
  });

  it('lists selected and available assets without including another workspace', async () => {
    for (const [suffix, expected] of [
      ['', included],
      ['/not-in-group', available],
    ]) {
      const res = await request(app.server)
        .get(`/api/asset-group/${groupId}/assets${suffix}`)
        .set(owner.headers)
        .expect(200);
      expect(res.body.data.map((asset: { id: string }) => asset.id)).toEqual([
        expected,
      ]);
    }
  });

  it('resolves the same workflow binding and selected asset scope when a run is requested', async () => {
    const start = jest
      .spyOn(app.app.get(WorkflowRunnerService), 'startRun')
      .mockResolvedValue({} as never);
    try {
      await request(app.server)
        .post(`/api/asset-group/workflows/${bindingId}/run`)
        .set(owner.headers)
        .expect(201);
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: owner.workspace.id,
          assetIds: [included],
        }),
      );
    } finally {
      start.mockRestore();
    }
  });

  it('keeps group and membership checks on the legacy endpoints', async () => {
    await request(app.server)
      .get(`/api/asset-group/${groupId}`)
      .set(other.headers)
      .expect(404);
    await request(app.server)
      .post(`/api/asset-group/${groupId}/assets`)
      .set(owner.headers)
      .send({ assetIds: [foreign] })
      .expect(404);
    await request(app.server)
      .get(`/api/asset-group/${groupId}`)
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
  });
});
