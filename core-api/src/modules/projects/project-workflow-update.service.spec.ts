import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
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
    const service = new ProjectWorkflowUpdateService({
      transaction: (callback: (value: typeof manager) => Promise<unknown>) =>
        callback(manager),
    } as unknown as DataSource);
    return { service, manager, workflow, binding, query };
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
});
