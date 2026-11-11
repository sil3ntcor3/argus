import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import type { ProjectWorkflowJobsService } from './project-workflow-jobs.service';
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
    const prepare = jest.fn().mockResolvedValue({ probe: { run: 'httpx' } });
    const getDEK = jest.fn().mockResolvedValue(Buffer.alloc(32));
    return {
      manager,
      transaction,
      prepare,
      getDEK,
      service: new ProjectWorkflowCreateService(
        { transaction } as unknown as DataSource,
        { prepare } as unknown as ProjectWorkflowJobsService,
        { getDEK } as unknown as WorkspaceEncryptionService,
      ),
    };
  }

  it('writes the workflow and its disabled binding through the same transaction manager', async () => {
    const { manager, service, prepare, getDEK } = setup();
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
    expect(prepare).not.toHaveBeenCalled();
    expect(getDEK).not.toHaveBeenCalled();
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

  it.each([
    {},
    { template: 'probe.yaml', jobs: { probe: { run: 'httpx' } } },
    { template: 'probe.yaml', copyFromProjectWorkflowId: randomUUID() },
    {
      jobs: { probe: { run: 'httpx' } },
      copyFromProjectWorkflowId: randomUUID(),
    },
  ])(
    'rejects ambiguous or missing sources before opening a transaction',
    async (input) => {
      const { service, transaction, getDEK } = setup();
      await expect(
        service.create(projectId, workspaceId, input),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transaction).not.toHaveBeenCalled();
      expect(getDEK).not.toHaveBeenCalled();
    },
  );

  it('prepares selected jobs with a fresh secret context before saving a disabled workflow', async () => {
    const { service, manager, prepare, getDEK, transaction } = setup();
    const jobs = { probe: { run: 'httpx' } };
    await expect(
      service.create(projectId, workspaceId, { jobs }),
    ).resolves.toMatchObject({
      name: 'Project workflow',
      schedule: 'disabled',
    });
    expect(getDEK).toHaveBeenCalledWith(workspaceId);
    expect(getDEK.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
    expect(prepare).toHaveBeenCalledWith(
      manager,
      workspaceId,
      jobs,
      {},
      Buffer.alloc(32),
    );
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(manager.save.mock.calls[0][1]).toMatchObject({
      name: 'Project workflow',
      content: { name: 'Project workflow', jobs },
    });
  });

  it('does not write either row when selected-job validation fails', async () => {
    const { service, manager, prepare } = setup();
    prepare.mockRejectedValueOnce(new BadRequestException('Invalid pipeline'));
    await expect(
      service.create(projectId, workspaceId, { jobs: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('copies a workspace binding graph without triggers or re-encrypting stored secrets', async () => {
    const { service, manager, prepare, getDEK } = setup();
    const sourceId = randomUUID();
    const jobs = {
      probe: { run: 'httpx', config: { key: 'stored-ciphertext' } },
    };
    manager.findOne.mockResolvedValueOnce({
      workflow: {
        name: 'Source scan',
        content: { name: 'Source scan', jobs, on: { schedule: '* * * * *' } },
      },
    });
    await expect(
      service.create(projectId, workspaceId, {
        copyFromProjectWorkflowId: sourceId,
      }),
    ).resolves.toMatchObject({
      name: 'Source scan (copy)',
      schedule: 'disabled',
    });
    expect(manager.findOne).toHaveBeenCalledWith(
      AssetGroupWorkflow,
      expect.objectContaining({
        where: {
          id: sourceId,
          assetGroup: { workspace: { id: workspaceId } },
          workflow: { workspace: { id: workspaceId } },
        },
        relations: { workflow: true },
      }),
    );
    expect(manager.save.mock.calls[0][1].content).toEqual({
      name: 'Source scan (copy)',
      jobs,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(getDEK).not.toHaveBeenCalled();
  });

  it('rejects inaccessible copy sources before saving either row', async () => {
    const { service, manager } = setup();
    manager.findOne.mockResolvedValueOnce(null);
    await expect(
      service.create(projectId, workspaceId, {
        copyFromProjectWorkflowId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('rejects an invalid stored source graph without creating a workflow', async () => {
    const { service, manager } = setup();
    manager.findOne.mockResolvedValueOnce({
      workflow: {
        name: 'Broken',
        content: { jobs: { a: { run: 'httpx', needs: ['missing'] } } },
      },
    });
    await expect(
      service.create(projectId, workspaceId, {
        copyFromProjectWorkflowId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).not.toHaveBeenCalled();
  });
});
