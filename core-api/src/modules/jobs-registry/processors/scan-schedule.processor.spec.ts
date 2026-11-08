import { JobRunType } from '@/common/enums/enum';
import type { AssetGroupWorkflowService } from '@/modules/asset-group/asset-group-workflow.service';
import type { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import type { AssetsService } from '@/modules/assets/assets.service';
import type { TargetDiscoverySchedulePayload } from '@/modules/targets/entities/target.entity';
import type { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  AssetGroupsScheduleConsumer,
  AssetsDiscoveryScheduleConsumer,
} from './scan-schedule.processor';

describe('AssetsDiscoveryScheduleConsumer', () => {
  const reScan = jest.fn();
  const getWorkspaceIdByTargetId = jest.fn();
  const consumer = new AssetsDiscoveryScheduleConsumer(
    { reScan } as unknown as AssetsService,
    { getWorkspaceIdByTargetId } as unknown as WorkspacesService,
  );
  const job = (workspaceId?: string) =>
    ({
      data: { id: 'target-1', workspaceId },
    }) as unknown as Job<TargetDiscoverySchedulePayload>;

  beforeEach(() => {
    reScan.mockReset();
    getWorkspaceIdByTargetId.mockReset();
  });

  it('uses the queued workspace for a current scheduled run', async () => {
    await consumer.process(job('workspace-1'));
    expect(getWorkspaceIdByTargetId).not.toHaveBeenCalled();
    expect(reScan).toHaveBeenCalledWith(
      'target-1',
      'workspace-1',
      JobRunType.SCHEDULED,
    );
  });

  it('resolves the workspace for an older queued run without a workspace ID', async () => {
    getWorkspaceIdByTargetId.mockResolvedValue('workspace-1');
    await consumer.process(job());
    expect(getWorkspaceIdByTargetId).toHaveBeenCalledWith('target-1');
    expect(reScan).toHaveBeenCalledWith(
      'target-1',
      'workspace-1',
      JobRunType.SCHEDULED,
    );
  });

  it('does not dispatch a legacy run without a target workspace', async () => {
    getWorkspaceIdByTargetId.mockResolvedValue(null);
    await expect(consumer.process(job())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(reScan).not.toHaveBeenCalled();
  });
});

describe('AssetGroupsScheduleConsumer', () => {
  const mockAssetGroupWorkflowService = {
    runGroupWorkflowScheduler: jest.fn(),
    removeGroupWorkflowScheduler: jest.fn(),
    getBindingWorkspace: jest.fn().mockResolvedValue('workspace-1'),
  };

  const createMockJob = (
    id: string,
    repeatJobKey?: string | null,
  ): Job<AssetGroupWorkflow> =>
    ({
      data: { id } as AssetGroupWorkflow,
      repeatJobKey: repeatJobKey ?? null,
      remove: jest.fn(),
    }) as unknown as Job<AssetGroupWorkflow>;

  let consumer: AssetGroupsScheduleConsumer;

  beforeEach(() => {
    jest.clearAllMocks();
    consumer = new AssetGroupsScheduleConsumer(
      mockAssetGroupWorkflowService as unknown as AssetGroupWorkflowService,
    );
  });

  it('runs the group workflow scheduler for the job payload', async () => {
    const job = createMockJob('agw-1', 'repeat:agw-1:1');

    await consumer.process(job);

    expect(mockAssetGroupWorkflowService.runGroupWorkflowScheduler).toHaveBeenCalledWith(
      'agw-1',
      JobRunType.SCHEDULED,
      'workspace-1',
    );
    expect(mockAssetGroupWorkflowService.removeGroupWorkflowScheduler).not.toHaveBeenCalled();
  });

  it('removes the BullMQ scheduler when the asset group workflow is not found', async () => {
    mockAssetGroupWorkflowService.runGroupWorkflowScheduler.mockRejectedValueOnce(
      new NotFoundException('Asset group workflow with ID "agw-1" not found'),
    );
    const job = createMockJob('agw-1', 'repeat:agw-1:1');

    await expect(consumer.process(job)).resolves.toBeUndefined();

    expect(mockAssetGroupWorkflowService.removeGroupWorkflowScheduler).toHaveBeenCalledWith(
      'repeat:agw-1:1',
    );
  });

  it('removes the current job when not found and no repeat key exists', async () => {
    mockAssetGroupWorkflowService.runGroupWorkflowScheduler.mockRejectedValueOnce(
      new NotFoundException('Asset group workflow with ID "agw-1" not found'),
    );
    const job = createMockJob('agw-1', null);

    await expect(consumer.process(job)).resolves.toBeUndefined();

    expect(job.remove).toHaveBeenCalled();
    expect(mockAssetGroupWorkflowService.removeGroupWorkflowScheduler).not.toHaveBeenCalled();
  });

  it('rethrows non-not-found errors and does not remove the job', async () => {
    const error = new BadRequestException('Asset group workflow has no assets');
    mockAssetGroupWorkflowService.runGroupWorkflowScheduler.mockRejectedValueOnce(error);
    const job = createMockJob('agw-1', 'repeat:agw-1:1');

    await expect(consumer.process(job)).rejects.toBe(error);

    expect(mockAssetGroupWorkflowService.removeGroupWorkflowScheduler).not.toHaveBeenCalled();
    expect(job.remove).not.toHaveBeenCalled();
  });
});
