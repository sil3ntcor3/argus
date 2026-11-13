import { BullMQName, JobRunType } from '@/common/enums/enum';
import { AssetGroupWorkflowService } from '@/modules/asset-group/asset-group-workflow.service';
import type { AssetGroupLastRunDto } from '@/modules/asset-group/dto/asset-group-last-run.dto';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { isGroupOwnedWorkflow } from '@/modules/asset-group/workflow-ownership';
import { ConnectorRegistryService } from '@/modules/connectors/connector-registry.service';
import {
  WorkflowRunnerService,
  type StartRunInput,
} from '@/modules/jobs-registry/workflow-runner.service';
import { ToolsService } from '@/modules/tools/tools.service';
import {
  getSensitiveFields,
  maskProfile,
} from '@/modules/tools/validators/tool-config-profiles.crypto';
import { Workflow } from '@/modules/workflows/entities/workflow.entity';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { DataSource, Not } from 'typeorm';
import type {
  ProjectWorkflowBindingDto,
  ProjectWorkflowRemovedDto,
  ProjectWorkflowRunReceiptDto,
  ProjectWorkflowViewDto,
  RunProjectWorkflowDto,
} from './dto/project-workflow-actions.dto';
import { ProjectTriggerReadService } from './project-trigger-read.service';
import { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';
import { lockProjectWorkflow } from './project-workflow-write-context';

@Injectable()
export class ProjectWorkflowActionsService {
  private readonly logger = new Logger(ProjectWorkflowActionsService.name);
  constructor(
    private readonly db: DataSource,
    private readonly runner: WorkflowRunnerService,
    private readonly legacy: AssetGroupWorkflowService,
    private readonly triggerRead: ProjectTriggerReadService,
    private readonly runtime: ProjectTriggerRuntimeService,
    private readonly connectors: ConnectorRegistryService,
    @InjectQueue(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE)
    private readonly schedules: Queue,
    private readonly tools: ToolsService,
  ) {}

  async list(
    projectId: string,
    workspaceId: string,
    canReadJobs: boolean,
  ): Promise<ProjectWorkflowBindingDto[]> {
    // This checks the parent even when it has no bindings, including archived projects.
    const triggers = await this.triggerRead.list(projectId, workspaceId);
    const bindings = await this.db.getRepository(AssetGroupWorkflow).find({
      where: {
        assetGroupId: projectId,
        assetGroup: { workspace: { id: workspaceId } },
        workflow: { workspace: { id: workspaceId } },
      },
      relations: { workflow: true },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const last = canReadJobs
      ? await this.legacy.getLastRunForWorkflows(
          bindings.map((b) => b.workflowId),
          { id: projectId, workspaceId },
        )
      : new Map<string, AssetGroupLastRunDto>();
    return bindings.map((b) => ({
      id: b.id,
      projectId: b.assetGroupId,
      workflowId: b.workflowId,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      schedule: b.schedule,
      workflow: this.safeWorkflow(b.workflow),
      triggers: triggers.filter((t) => t.projectWorkflowId === b.id),
      lastRun: last.get(b.workflowId) ?? null,
    }));
  }

  private safeWorkflow(workflow: Workflow): ProjectWorkflowViewDto {
    const content = structuredClone(workflow.content);
    for (const job of Object.values(content.jobs ?? {})) {
      if (!job.config) continue;
      const schema = this.connectors.getConnector(job.run)?.configSchema;
      // Also mask conventional names when an older or missing manifest omits them.
      const heuristic = getSensitiveFields({
        properties: Object.fromEntries(
          Object.keys(job.config).map((key) => [key, {}]),
        ),
      });
      job.config = maskProfile(job.config, [
        ...new Set([...getSensitiveFields(schema), ...heuristic]),
      ]);
    }
    return {
      id: workflow.id,
      name: workflow.name,
      filePath: workflow.filePath,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      isCanEdit: workflow.isCanEdit,
      isCanDelete: workflow.isCanDelete,
      content,
    };
  }

  async run(
    projectId: string,
    workspaceId: string,
    bindingId: string,
    dto: RunProjectWorkflowDto,
  ): Promise<ProjectWorkflowRunReceiptDto> {
    const binding = await this.db
      .getRepository(AssetGroupWorkflow)
      .findOne({
        where: {
          id: bindingId,
          assetGroupId: projectId,
          assetGroup: { workspace: { id: workspaceId } },
          workflow: { workspace: { id: workspaceId } },
        },
        relations: { workflow: { workspace: true } },
      });
    if (!binding) throw new NotFoundException('Project workflow not found');
    const jobs = Object.values(binding.workflow.content.jobs ?? {});
    if (!jobs.length)
      throw new BadRequestException('Workflow has no runnable steps');
    const roots = [
      ...new Set(
        jobs.filter((job) => !job.needs?.length).map((job) => job.run),
      ),
    ];
    const installed = await this.tools.getToolByNames({
      names: roots,
      isInstalled: true,
    });
    if (roots.some((name) => !installed.some((tool) => tool.name === name)))
      throw new BadRequestException('A root tool is not installed');
    const input: StartRunInput = {
      workflow: binding.workflow,
      workspaceId,
      jobName: binding.workflow.name,
      jobRunType: JobRunType.MANUAL,
      projectId,
      projectWorkflowId: bindingId,
    };
    const result = await this.runner.startRun(input, async (manager) => {
      const locked = await lockProjectWorkflow(
        manager,
        projectId,
        workspaceId,
        bindingId,
      );
      if (
        locked.workflow.id !== binding.workflow.id ||
        locked.workflow.updatedAt.getTime() !==
          binding.workflow.updatedAt.getTime() ||
        JSON.stringify(locked.workflow.content) !==
          JSON.stringify(binding.workflow.content)
      )
        throw new BadRequestException('Workflow changed before launch');
      const rows = await manager.query<{ id: string }[]>(
        `SELECT a.id FROM project_assets pa JOIN assets a ON a.id=pa."assetId" JOIN targets t ON t.id=a."targetId" WHERE pa."projectId"=$1 AND t."workspaceId"=$2 AND a."isEnabled"=true${dto.assetIds ? ' AND a.id=ANY($3::uuid[])' : ''} ORDER BY a.id FOR SHARE OF a,t`,
        dto.assetIds
          ? [projectId, workspaceId, dto.assetIds]
          : [projectId, workspaceId],
      );
      if (!rows.length || (dto.assetIds && rows.length !== dto.assetIds.length))
        throw new BadRequestException('No eligible project asset scope');
      input.assetIds = rows.map((row) => row.id);
    });
    if (!result.jobHistory)
      throw new BadRequestException('Workflow has no runnable steps');
    return {
      jobHistoryId: result.jobHistory.id,
      assets: input.assetIds!.length,
    };
  }

  async remove(
    projectId: string,
    workspaceId: string,
    bindingId: string,
  ): Promise<ProjectWorkflowRemovedDto> {
    const removed = await this.db.transaction(async (manager) => {
      const { workflow, binding } = await lockProjectWorkflow(
        manager,
        projectId,
        workspaceId,
        bindingId,
      );
      const reused = await manager.exists(AssetGroupWorkflow, {
        where: { workflowId: workflow.id, id: Not(binding.id) },
      });
      await manager.delete(AssetGroupWorkflow, { id: binding.id });
      if (isGroupOwnedWorkflow(workflow, projectId.toLowerCase()) && !reused)
        await manager.delete(Workflow, { id: workflow.id });
      return { name: workflow.name, jobId: binding.jobId };
    });
    // Definitions commit first. The consumer rejects stale bindings and periodic
    // reconciliation repairs project-trigger cleanup if Redis is temporarily down.
    if (removed.jobId) {
      try {
        const scheduler = await this.schedules.getJobScheduler(removed.jobId);
        if (scheduler?.name === bindingId.toLowerCase())
          await this.schedules.removeJobScheduler(removed.jobId);
      } catch {
        this.logger.warn(
          'Legacy schedule cleanup deferred to the missing-binding consumer',
        );
      }
    }
    try {
      await this.runtime.reconcile();
    } catch {
      this.logger.warn(
        'Project trigger cleanup deferred to periodic reconciliation',
      );
    }
    return { message: 'Workflow removed from project', name: removed.name };
  }
}
