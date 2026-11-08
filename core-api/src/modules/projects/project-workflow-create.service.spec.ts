import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ProjectWorkflowCreateService } from './project-workflow-create.service';

describe('ProjectWorkflowCreateService', () => {
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const workflowId = randomUUID();
  const dto = { template: 'probe.yaml' };

  function setup() {
    const manager = {
      query: jest.fn().mockResolvedValue([{ id: projectId, archivedAt: null }]),
      findOne: jest.fn().mockResolvedValue({
        name: 'Probe',
        content: { jobs: { probe: { run: 'httpx' } } },
      }),
      save: jest
        .fn()
        .mockResolvedValueOnce({ id: workflowId })
        .mockResolvedValueOnce({ id: randomUUID() }),
    };
    const transaction = jest.fn(
      (callback: (value: typeof manager) => Promise<unknown>) =>
        callback(manager),
    );
    return {
      manager,
      service: new ProjectWorkflowCreateService({
        transaction,
      } as unknown as DataSource),
    };
  }

  it('writes the workflow and its disabled binding through the same transaction manager', async () => {
    const { manager, service } = setup();
    await expect(service.create(projectId, workspaceId, dto)).resolves.toEqual({
      id: expect.any(String),
      workflowId,
      name: 'Probe',
      schedule: 'disabled',
    });
    expect(manager.query).toHaveBeenNthCalledWith(
      1, expect.stringContaining('FOR KEY SHARE'), [workspaceId],
    );
    expect(manager.save).toHaveBeenNthCalledWith(2, AssetGroupWorkflow, {
      assetGroupId: projectId,
      workflowId,
      schedule: 'disabled',
      jobId: null,
    });
  });

  it('rejects an invalid stored template before saving either row', async () => {
    const { manager, service } = setup();
    manager.findOne.mockResolvedValueOnce({
      name: 'Invalid',
      content: { jobs: { broken: { run: '' } } },
    });
    await expect(
      service.create(projectId, workspaceId, dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).not.toHaveBeenCalled();
  });
});
