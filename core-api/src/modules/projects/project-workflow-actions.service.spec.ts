import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Queue } from 'bullmq';
import type { AssetGroupWorkflowService } from '../asset-group/asset-group-workflow.service';
import type { AssetGroupWorkflow } from '../asset-group/entities/asset-groups-workflows.entity';
import type { ConnectorRegistryService } from '../connectors/connector-registry.service';
import type {
  WorkflowRunnerService,
  StartRunInput,
} from '../jobs-registry/workflow-runner.service';
import { Workflow } from '../workflows/entities/workflow.entity';
import type { ProjectTriggerReadService } from './project-trigger-read.service';
import type { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';
import type { ToolsService } from '../tools/tools.service';
import { ProjectWorkflowActionsService } from './project-workflow-actions.service';

describe('Project workflow actions', () => {
  const projectId = randomUUID(),
    workspaceId = randomUUID(),
    bindingId = randomUUID(),
    assetId = randomUUID();
  function setup() {
    const workflow = {
      id: randomUUID(),
      name: 'Probe',
      filePath: `project-${projectId}-probe.yaml`,
      isCanEdit: true,
      isCanDelete: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      content: {
        name: 'Probe',
        jobs: {
          probe: {
            run: 'httpx',
            config: { apiKey: 'never-expose', username: 'visible' },
          },
        },
      },
    } as Workflow;
    const binding = {
      id: bindingId,
      assetGroupId: projectId,
      workflowId: workflow.id,
      workflow,
      schedule: 'disabled',
      jobId: null,
    } as AssetGroupWorkflow;
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(workflow),
    };
    const repo = {
      find: jest.fn().mockResolvedValue([binding]),
      findOne: jest.fn().mockResolvedValue(binding),
      findBy: jest.fn().mockResolvedValue([{ name: 'httpx' }]),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const manager = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(
            sql.includes('FROM projects')
              ? [{ id: projectId, archivedAt: null }]
              : sql.includes('project_assets')
                ? [{ id: assetId }]
                : [],
          ),
        ),
      getRepository: jest.fn().mockReturnValue(repo),
      findOne: jest.fn().mockResolvedValue(binding),
      exists: jest.fn().mockResolvedValue(false),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const db = {
      getRepository: jest.fn().mockReturnValue(repo),
      transaction: jest.fn((fn: (m: typeof manager) => Promise<unknown>) =>
        fn(manager),
      ),
    };
    const run = jest.fn(
      async (
        _input: StartRunInput,
        validate: (m: typeof manager) => Promise<void>,
      ) => {
        await validate(manager);
        return { jobHistory: { id: 'durable-id' }, dispatched: 1 };
      },
    );
    const last = jest
      .fn()
      .mockResolvedValue(new Map([[workflow.id, { id: 'last-id' }]]));
    const list = jest
      .fn()
      .mockResolvedValue([{ id: 'trigger', projectWorkflowId: bindingId }]);
    const reconcile = jest.fn().mockResolvedValue(undefined);
    const getJobScheduler = jest.fn().mockResolvedValue({ name: bindingId });
    const removeJobScheduler = jest.fn().mockResolvedValue(true);
    const service = new ProjectWorkflowActionsService(
      db as unknown as DataSource,
      { startRun: run } as unknown as WorkflowRunnerService,
      { getLastRunForWorkflows: last } as unknown as AssetGroupWorkflowService,
      { list } as unknown as ProjectTriggerReadService,
      { reconcile } as unknown as ProjectTriggerRuntimeService,
      { getConnector: () => undefined } as unknown as ConnectorRegistryService,
      { getJobScheduler, removeJobScheduler } as unknown as Queue,
      { getToolByNames: repo.findBy } as unknown as ToolsService,
    );
    return {
      service,
      workflow,
      binding,
      manager,
      repo,
      qb,
      run,
      last,
      list,
      reconcile,
      getJobScheduler,
      removeJobScheduler,
    };
  }
  it('projects only safe workflow fields, masks credentials without changing storage and gates run data', async () => {
    const f = setup();
    const [row] = await f.service.list(projectId, workspaceId, false);
    expect(row.lastRun).toBeNull();
    expect(f.last).not.toHaveBeenCalled();
    expect(row.workflow.content.jobs.probe.config?.apiKey).not.toBe(
      'never-expose',
    );
    expect(f.workflow.content.jobs.probe.config?.apiKey).toBe('never-expose');
    expect(row).not.toHaveProperty('jobId');
    expect(row.triggers).toHaveLength(1);
    expect(
      (await f.service.list(projectId, workspaceId, true))[0].lastRun,
    ).toEqual({ id: 'last-id' });
  });
  it('returns the durable launch identity with the scope selected under transaction locks', async () => {
    const f = setup();
    await expect(
      f.service.run(projectId, workspaceId, bindingId, { assetIds: [assetId] }),
    ).resolves.toEqual({ jobHistoryId: 'durable-id', assets: 1 });
    expect(f.run.mock.calls[0][0]).toMatchObject({
      projectId,
      projectWorkflowId: bindingId,
      assetIds: [assetId],
    });
    expect(
      f.manager.query.mock.calls.find(([sql]) =>
        sql.includes('project_assets'),
      ),
    ).toEqual([
      expect.stringContaining('FOR SHARE OF a,t'),
      [projectId, workspaceId, [assetId]],
    ]);
  });
  it.each([
    'missing',
    'empty',
    'tool',
    'changed',
    'scope',
    'archived',
    'parent',
    'binding',
  ])('rejects %s launch before creating a durable run', async (scenario) => {
    const f = setup();
    if (scenario === 'missing') f.repo.findOne.mockResolvedValue(null);
    if (scenario === 'empty') f.workflow.content.jobs = {};
    if (scenario === 'tool') f.repo.findBy.mockResolvedValue([]);
    if (scenario === 'changed')
      f.qb.getOne.mockResolvedValue({ ...f.workflow, updatedAt: new Date(0) });
    if (scenario === 'scope')
      f.manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('FROM projects') ? [{ id: projectId }] : [],
        ),
      );
    if (scenario === 'archived')
      f.manager.query.mockResolvedValue([
        { id: projectId, archivedAt: new Date() },
      ]);
    if (scenario === 'parent') f.manager.query.mockResolvedValue([]);
    if (scenario === 'binding') f.manager.findOne.mockResolvedValue(null);
    await expect(
      f.service.run(projectId, workspaceId, bindingId, {}),
    ).rejects.toThrow();
  });
  it.each([false, true])(
    'deletes an owned definition only when not reused (reused=%s)',
    async (reused) => {
      const f = setup();
      f.manager.exists.mockResolvedValue(reused);
      await f.service.remove(projectId, workspaceId, bindingId);
      expect(f.manager.delete).toHaveBeenCalledTimes(reused ? 1 : 2);
      if (!reused)
        expect(f.manager.delete).toHaveBeenLastCalledWith(Workflow, {
          id: f.workflow.id,
        });
      expect(f.reconcile).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves library workflows and removes only the matching legacy scheduler after commit', async () => {
    const f = setup();
    f.workflow.filePath = 'library.yaml';
    f.binding.jobId = 'legacy-key';
    await f.service.remove(projectId, workspaceId, bindingId);
    expect(f.manager.delete).toHaveBeenCalledTimes(1);
    expect(f.removeJobScheduler).toHaveBeenCalledWith('legacy-key');
    expect(f.manager.delete.mock.invocationCallOrder[0]).toBeLessThan(
      f.removeJobScheduler.mock.invocationCallOrder[0],
    );
    f.getJobScheduler.mockResolvedValue({ name: randomUUID() });
    f.removeJobScheduler.mockClear();
    await f.service.remove(projectId, workspaceId, bindingId);
    expect(f.removeJobScheduler).not.toHaveBeenCalled();
  });
  it('returns durable removal despite Redis failures and still attempts trigger reconciliation', async () => {
    const f = setup();
    f.binding.jobId = 'legacy-key';
    f.getJobScheduler.mockRejectedValue(new Error('Redis down'));
    f.reconcile.mockRejectedValue(new Error('Redis still down'));
    await expect(
      f.service.remove(projectId, workspaceId, bindingId),
    ).resolves.toMatchObject({ name: 'Probe' });
    expect(f.reconcile).toHaveBeenCalledTimes(1);
  });
});
