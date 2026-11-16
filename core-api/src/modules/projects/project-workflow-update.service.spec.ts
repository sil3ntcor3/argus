import type { ProjectTriggerDefinitionService } from './project-trigger-definition.service';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import type { ProjectWorkflowJobsService } from './project-workflow-jobs.service';
import { ProjectWorkflowUpdateService } from './project-workflow-update.service';

describe('ProjectWorkflowUpdateService', () => {
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const bindingId = randomUUID();

  function setup() {
    const workflow = {
      id: randomUUID(),
      name: 'Before',
      isCanEdit: true,
      isCanDelete: true,
      filePath: `project-${projectId}-${randomUUID()}.yaml`,
      content: {
        name: 'Before',
        jobs: { probe: { run: 'httpx', config: { secret: 'ciphertext' } } },
        on: { schedule: '0 0 * * *' },
      },
    };
    const binding = {
      id: bindingId,
      workflowId: workflow.id,
      schedule: '0 0 * * *',
      jobId: 'scheduler',
    };
    const query = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(workflow),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([{ id: projectId, archivedAt: null }]),
      findOne: jest.fn().mockResolvedValue(binding),
      getRepository: () => ({ createQueryBuilder: () => query }),
      save: jest.fn((_entity: unknown, value: unknown) =>
        Promise.resolve(value),
      ),
    };
    const transaction = jest.fn(
      (callback: (value: typeof manager) => Promise<unknown>) =>
        callback(manager),
    );
    const prepared = {
      probe: { run: 'httpx', config: { secret: 'ciphertext' } },
    };
    const prepare = jest.fn().mockResolvedValue(prepared);
    const dek = Buffer.alloc(32, 7);
    const getDEK = jest.fn().mockResolvedValue(dek);
    const service = new ProjectWorkflowUpdateService(
      { transaction } as unknown as DataSource,
      { prepare } as unknown as ProjectWorkflowJobsService,
      { getDEK } as unknown as WorkspaceEncryptionService,
        {} as ProjectTriggerDefinitionService,
    );
    return {
      service,
      manager,
      workflow,
      binding,
      query,
      transaction,
      prepare,
      prepared,
      getDEK,
      dek,
    };
  }

  it('preserves authored content, encrypted configuration and schedule while renaming', async () => {
    const { service, workflow, binding } = setup();
    const result = await service.update(projectId, workspaceId, bindingId, {
      name: 'After',
    });
    expect(result.workflow.name).toBe('After');
    expect(result.workflow.content).toEqual({
      ...workflow.content,
      name: 'After',
    });
    expect(result.schedule).toBe(binding.schedule);
    expect(result.jobId).toBe(binding.jobId);
    expect(workflow.name).toBe('Before');
  });

  it('rejects an empty edit before acquiring a connection or encryption key', async () => {
    const { service, transaction, getDEK } = setup();
    await expect(
      service.update(projectId, workspaceId, bindingId, {}),
    ).rejects.toThrow('Provide a name or pipeline');
    expect(transaction).not.toHaveBeenCalled();
    expect(getDEK).not.toHaveBeenCalled();
  });

  it('resolves the key before locking and saves only the prepared graph', async () => {
    const {
      service,
      transaction,
      getDEK,
      prepare,
      prepared,
      dek,
      manager,
      workflow,
    } = setup();
    const jobs = { probe: { run: 'httpx' } };
    const result = await service.update(projectId, workspaceId, bindingId, {
      jobs,
    });
    expect(getDEK).toHaveBeenCalledWith(workspaceId);
    expect(getDEK.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
    expect(prepare).toHaveBeenCalledWith(
      manager,
      workspaceId,
      jobs,
      workflow.content.jobs,
      dek,
    );
    expect(result.workflow.content).toEqual({
      ...workflow.content,
      jobs: prepared,
    });
  });

  it('uses the selected canonical project ID for legacy uppercase route IDs', async () => {
    const { service } = setup();
    await expect(
      service.update(projectId.toUpperCase(), workspaceId, bindingId, {
        name: 'After',
      }),
    ).resolves.toMatchObject({ workflow: { name: 'After' } });
  });

  it.each([false, true])(
    'refuses a missing or archived project (archived=%s)',
    async (archived) => {
      const { service, manager } = setup();
      manager.query
        .mockResolvedValueOnce([{ id: workspaceId }])
        .mockResolvedValueOnce(
          archived ? [{ id: projectId, archivedAt: new Date() }] : [],
        );
      await expect(
        service.update(projectId, workspaceId, bindingId, { name: 'After' }),
      ).rejects.toThrow(archived ? 'Project is archived' : 'Project not found');
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('refuses a workflow missing from the scoped join', async () => {
    const { service, query, manager } = setup();
    query.getOne.mockResolvedValueOnce(null);
    await expect(
      service.update(projectId, workspaceId, bindingId, { name: 'After' }),
    ).rejects.toThrow('Project workflow not found');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it.each(['readonly', 'shared', 'not-owned'])(
    'refuses %s workflows without changing saved content',
    async (kind) => {
      const { service, workflow, manager } = setup();
      if (kind === 'readonly') workflow.isCanEdit = false;
      else if (kind === 'shared') workflow.isCanDelete = false;
      else workflow.filePath = 'global-template.yaml';
      await expect(
        service.update(projectId, workspaceId, bindingId, { name: 'After' }),
      ).rejects.toThrow('Workflow is not editable by this project');
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('refuses a binding removed after selecting the workflow', async () => {
    const { service, manager } = setup();
    manager.findOne.mockResolvedValueOnce(null);
    await expect(
      service.update(projectId, workspaceId, bindingId, { name: 'After' }),
    ).rejects.toThrow('Project workflow not found');
    expect(manager.save).not.toHaveBeenCalled();
  });
});
