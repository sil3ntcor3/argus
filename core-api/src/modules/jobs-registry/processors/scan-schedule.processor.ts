import { ProjectArchivedException } from '@/modules/projects/project-archive-state';
import { ProjectTriggerRuntimeService } from '@/modules/projects/project-trigger-runtime.service';
import { BullMQName, JobRunType } from '@/common/enums/enum';
import { AssetGroupWorkflowService } from '@/modules/asset-group/asset-group-workflow.service';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { AssetsService } from '@/modules/assets/assets.service';
import type { TargetDiscoverySchedulePayload } from '@/modules/targets/entities/target.entity';
import { TargetsService } from '@/modules/targets/targets.service';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { Logger, NotFoundException } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor(BullMQName.ASSETS_DISCOVERY_SCHEDULE)
export class AssetsDiscoveryScheduleConsumer extends WorkerHost {
  constructor(
    private assetService: AssetsService,
    private workspaces: WorkspacesService,
    private targets: TargetsService,
  ) {
    super();
  }

  async process(job: Job<TargetDiscoverySchedulePayload>): Promise<void> {
    const { id, workspaceId } = job.data;
    try {
      const scope =
        workspaceId ?? (await this.workspaces.getWorkspaceIdByTargetId(id));
      if (!scope) throw new NotFoundException('Target not found');
      await this.assetService.reScan(id, scope, JobRunType.SCHEDULED);
    } catch (error) {
      if (
        !(error instanceof NotFoundException) ||
        !(await this.targets.removeOrphanedDiscoverySchedule(
          id,
          job.repeatJobKey,
        ))
      )
        throw error;
    }
  }
}

@Processor(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE)
export class AssetGroupsScheduleConsumer extends WorkerHost {
  private readonly logger = new Logger(AssetGroupsScheduleConsumer.name);
  constructor(private assetGroupWorkflowService: AssetGroupWorkflowService, private readonly triggers: ProjectTriggerRuntimeService) {
    super();
  }
  async process(job: Job<AssetGroupWorkflow & { triggerId?: string; cron?: string }>): Promise<void> {
    if (job.data.triggerId) { await this.triggers.fireCron(job.data.triggerId, job.id ?? String(job.timestamp), job.data.cron, (job.data as { epoch?: string }).epoch); return; }
    const assetGroupWorkflowId = job.data.id;
    try {
      // Internal scheduler: the binding id comes from our own queue, so the
      // owning workspace is resolved from the row rather than a request header.
      const workspaceId =
        await this.assetGroupWorkflowService.getBindingWorkspace(
          assetGroupWorkflowId,
        );
      await this.assetGroupWorkflowService.runGroupWorkflowScheduler(
        assetGroupWorkflowId,
        JobRunType.SCHEDULED,
        workspaceId,
        job.repeatJobKey,
      );
    } catch (error) {
      // A deleted or archived binding may retain a repeat after Redis cleanup
      // failed. Remove only the key from this actual delivery.
      if (error instanceof NotFoundException || error instanceof ProjectArchivedException) {
        this.logger.warn(
          `Asset group workflow "${assetGroupWorkflowId}" is unavailable, removing scheduled job`,
        );
        if (job.repeatJobKey) {
          await this.assetGroupWorkflowService.removeGroupWorkflowScheduler(
            job.repeatJobKey,
          );
        } else {
          await job.remove();
        }
        return;
      }
      throw error;
    }
  }
}
