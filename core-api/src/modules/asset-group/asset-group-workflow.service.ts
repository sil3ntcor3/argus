import { ProjectLegacyScheduleService } from '../projects/project-legacy-schedule.service';
import { ProjectArchivedException } from '../projects/project-archive-state';
import { lockProjectScope } from '../projects/project-scope-sync';
import type { StartRunInput } from '../jobs-registry/workflow-runner.service';
import { lockProjectWorkflow } from '../projects/project-workflow-write-context';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { BullMQName, CronSchedule, JobRunType, JobStatus } from '@/common/enums/enum';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { Asset } from '../assets/entities/assets.entity';
import { JobHistory } from '../jobs-registry/entities/job-history.entity';
import { WorkflowRunnerService } from '../jobs-registry/workflow-runner.service';
import { ToolsService } from '../tools/tools.service';
import { Workflow } from '../workflows/entities/workflow.entity';
import { buildWorkflowGraph } from '../workflows/workflow-graph';
import { AssetGroupLastRunDto } from './dto/asset-group-last-run.dto';
import { AssetGroupWorkflow } from './entities/asset-groups-workflows.entity';
import { AssetGroup } from './entities/asset-groups.entity';

@Injectable()
export class AssetGroupWorkflowService {
  private readonly logger = new Logger(AssetGroupWorkflowService.name);
  constructor(
    @InjectRepository(AssetGroup)
    private readonly assetGroupRepo: Repository<AssetGroup>,
    @InjectRepository(AssetGroupWorkflow)
    private readonly assetGroupWorkflowRepo: Repository<AssetGroupWorkflow>,
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    @InjectRepository(JobHistory)
    private readonly jobHistoryRepo: Repository<JobHistory>,
    @InjectRepository(Asset)
    private readonly assetRepo: Repository<Asset>,
    @InjectQueue(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE)
    private scanScheduleQueue: Queue<AssetGroupWorkflow>,
    private toolsService: ToolsService,
    private workflowRunnerService: WorkflowRunnerService,
    private readonly legacySchedules: ProjectLegacyScheduleService,
  ) {}

  /**
   * Resolves the most recent job history per workflow,
   * deriving each status from the individual job statuses.
   * A project context additionally requires its exact persisted workflow binding.
   */
  async getLastRunForWorkflows(
    workflowIds: string[],
    project?: { id: string; workspaceId: string },
  ): Promise<Map<string, AssetGroupLastRunDto>> {
    if (workflowIds.length === 0) {
      return new Map();
    }

    interface RawJobHistoryRow {
      workflowId: string;
      id: string;
      createdAt: Date;
      updatedAt: Date;
      totalJobs: string;
      status: JobStatus;
      workflowName: string;
      jobHistoryName: string;
      jobRunType: JobRunType;
    }

    const query = this.jobHistoryRepo
      .createQueryBuilder('jobHistory')
      .leftJoin('jobHistory.workflow', 'workflow')
      .where('jobHistory.workflowId IN (:...workflowIds)', { workflowIds })
      .select([
        '"jobHistory"."workflowId" as "workflowId"',
        '"jobHistory".id as "id"',
        '"jobHistory"."createdAt" as "createdAt"',
        '"jobHistory"."updatedAt" as "updatedAt"',
        '"jobHistory"."jobHistoryName" as "jobHistoryName"',
        '"jobHistory"."jobRunType" as "jobRunType"',
        '"workflow"."name" as "workflowName"',
        // Subquery to count total jobs for this job history
        '(SELECT COUNT(*) FROM jobs WHERE "jobHistoryId" = "jobHistory".id) as "totalJobs"',
        // Subquery with CASE to calculate status based on job statuses
        `(
          SELECT
            CASE
              WHEN COUNT(*) FILTER (WHERE status = '${JobStatus.CANCELLED}') > 0
                   AND COUNT(*) FILTER (WHERE status IN ('${JobStatus.PENDING}', '${JobStatus.IN_PROGRESS}')) = 0 THEN '${JobStatus.CANCELLED}'
              WHEN COUNT(*) FILTER (WHERE status = '${JobStatus.FAILED}') > 0 THEN '${JobStatus.FAILED}'
              WHEN COUNT(*) FILTER (WHERE status = '${JobStatus.IN_PROGRESS}') > 0 THEN '${JobStatus.IN_PROGRESS}'
              WHEN COUNT(*) FILTER (WHERE status = '${JobStatus.COMPLETED}') = COUNT(*) AND COUNT(*) > 0 THEN '${JobStatus.COMPLETED}'
              ELSE '${JobStatus.PENDING}'
            END
          FROM jobs
          WHERE "jobHistoryId" = "jobHistory".id
        ) as "status"`,
      ])
      .distinctOn(['"jobHistory"."workflowId"'])
      .orderBy('"jobHistory"."workflowId"')
      .addOrderBy('jobHistory.createdAt', 'DESC');

    if (project) {
      query
        .andWhere('"jobHistory"."projectId" = :projectId', { projectId: project.id })
        .andWhere('"workflow"."workspaceId" = :workspaceId', {
          workspaceId: project.workspaceId,
        })
        .andWhere(`EXISTS (SELECT 1 FROM project_workflows pw
          WHERE pw.id = "jobHistory"."projectWorkflowId"
            AND pw."projectId" = :projectId AND pw."workflowId" = "jobHistory"."workflowId")`)
        .addOrderBy('jobHistory.id', 'DESC');
    }
    const raw = await query.getRawMany<RawJobHistoryRow>();

    const lastRunByWorkflow = new Map<string, AssetGroupLastRunDto>();

    for (const row of raw) {
      // A job history with zero job rows (e.g. all jobs were deleted) is not
      // a meaningful "last run": the status CASE falls through to 'pending',
      // which would wrongly lock the group out of re-running. Skip it so the
      // UI falls back to "Never".
      if (parseInt(row.totalJobs, 10) === 0) {
        continue;
      }

      lastRunByWorkflow.set(row.workflowId, {
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        totalJobs: parseInt(row.totalJobs, 10),
        status: row.status,
        workflowName: row.workflowName,
        jobHistoryName: row.jobHistoryName,
        jobRunType: row.jobRunType,
      });
    }

    return lastRunByWorkflow;
  }

  /**
   * Associates multiple workflows with the specified asset group
   */
  async addManyWorkflows(
    groupId: string,
    workflowIds: string[],
    schedule: string = CronSchedule.EVERY_3_DAYS,
    workspaceId: string,
  ): Promise<DefaultMessageResponseDto> {
    try {
      const count = await this.assetGroupRepo.manager.transaction(async manager => {
        await manager.query('SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE', [workspaceId]);
        const id = await lockProjectScope(manager, groupId, workspaceId);
        const rows = await manager.query<{ id: string }[]>('SELECT id FROM workflows WHERE id=ANY($1::uuid[]) AND "workspaceId"=$2 ORDER BY id FOR KEY SHARE', [workflowIds, workspaceId]);
        if (rows.length !== workflowIds.length) throw new NotFoundException('One or more workflows not found');
        const existing = await manager.find(AssetGroupWorkflow, { where: { assetGroupId: id, workflowId: In(workflowIds) } });
        if (existing.length) throw new BadRequestException('Workflows are already associated with this project');
        await manager.save(AssetGroupWorkflow, workflowIds.map(workflowId => ({ id: randomUUID(), assetGroupId: id, workflowId, schedule, jobId: null })));
        return workflowIds.length;
      });
      await this.legacySchedules.reconcile(groupId, workspaceId).catch(() => this.logger.warn('Legacy project schedule creation will retry'));
      return { message: `${count} workflows successfully added to asset group "${groupId}"` };

    } catch (error) {
      this.logger.error(
        `Error adding workflows to asset group with ID ${groupId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Disassociates multiple workflows from the asset group
   */
  async removeManyWorkflows(
    groupId: string,
    workflowIds: string[],
    workspaceId?: string,
  ): Promise<DefaultMessageResponseDto> {
    try {
      const group = await this.assetGroupRepo.findOne({ where: { id: groupId }, relations: ['workspace'] });
      if (!group) throw new NotFoundException('Project not found');
      if (workspaceId && group.workspace.id !== workspaceId) throw new ForbiddenException('Group does not belong to this workspace');
      const rows = await this.assetGroupRepo.manager.transaction(async manager => {
        await manager.query('SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE', [group.workspace.id]);
        const id = await lockProjectScope(manager, groupId, group.workspace.id);
        await manager.query('SELECT id FROM workflows WHERE id=ANY($1::uuid[]) AND "workspaceId"=$2 ORDER BY id FOR KEY SHARE', [workflowIds, group.workspace.id]);
        const bindings = await manager.find(AssetGroupWorkflow, { where: { assetGroupId: id, workflowId: In(workflowIds) } });
        if (!bindings.length || bindings.length !== workflowIds.length) throw new NotFoundException('One or more workflow assignments not found');
        await manager.delete(AssetGroupWorkflow, { id: In(bindings.map(binding => binding.id)) });
        return bindings;
      });
      await this.legacySchedules.remove(rows).catch(() => this.logger.warn('Legacy project schedule removal deferred to delivery cleanup'));
      return { message: `${rows.length} workflows successfully removed from asset group "${groupId}"` };

    } catch (error) {
      this.logger.error(
        `Error removing workflows from asset group with ID ${groupId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Updates an asset group workflow relationship (schedule, job, etc.)
   */
  async updateAssetGroupWorkflow(
    assetGroupWorkflowId: string,
    updateData: Partial<{
      schedule?: string;
      jobId?: string;
    }>,
    workspaceId: string,
  ): Promise<AssetGroupWorkflow> {
    try {
      // Find the existing relationship by ID, constrained to the caller's
      // workspace via the owning asset group.
      const assetGroupWorkspace = await this.assetGroupWorkflowRepo.findOne({
        where: {
          id: assetGroupWorkflowId,
          assetGroup: { workspace: { id: workspaceId } },
        },
        relations: ['assetGroup', 'workflow'],
      });

      if (!assetGroupWorkspace) {
        throw new NotFoundException(
          `Asset group workflow relationship with ID "${assetGroupWorkflowId}" not found`,
        );
      }

      // Commit the definition under the same locks as canonical removal. Never
      // save the detached entity after Redis I/O: save() could INSERT it again.
      const committed = await this.assetGroupWorkflowRepo.manager.transaction(async manager => {
        const { binding } = await lockProjectWorkflow(manager, assetGroupWorkspace.assetGroup.id, workspaceId, assetGroupWorkflowId);
        const previousJobId = binding.jobId;
        if (updateData.schedule !== undefined) {
          binding.schedule = updateData.schedule;
          binding.jobId = null;
          await manager.update(AssetGroupWorkflow, { id: binding.id }, { schedule: binding.schedule, jobId: null });
        }
        return { binding, previousJobId };
      });
      if (updateData.schedule !== undefined) {
        await this.legacySchedules.remove([{ id: committed.binding.id, jobId: committed.previousJobId }]);
        await this.legacySchedules.reconcile(assetGroupWorkspace.assetGroup.id, workspaceId);
      }
      const current = await this.assetGroupWorkflowRepo.findOne({ where: { id: assetGroupWorkflowId, assetGroup: { workspace: { id: workspaceId } } }, relations: ['assetGroup', 'workflow'] });
      if (!current) throw new NotFoundException('Workflow assignment was removed');
      return current;
    } catch (error) {
      this.logger.error(
        `Error updating asset group workflow relationship with ID ${assetGroupWorkflowId}:`,
        error,
      );
      throw error;
    }
  }

  /**
 * Resolves the workspace that owns a group→workflow binding.
 *
 * Needed by the internal scheduler, which receives only the binding id from the
 * queue. The HTTP path gets this from `@WorkspaceId()` instead.
 */
async getBindingWorkspace(assetGroupWorkflowId: string): Promise<string> {
    const binding = await this.assetGroupWorkflowRepo.findOne({
      where: { id: assetGroupWorkflowId },
      relations: { workflow: { workspace: true }, assetGroup: { workspace: true } },
    });

    const workspaceId =
      binding?.workflow?.workspace?.id ?? binding?.assetGroup?.workspace?.id;

    if (!workspaceId) {
      throw new NotFoundException(
        `Asset group workflow with ID "${assetGroupWorkflowId}" has no resolvable workspace`,
      );
    }

    return workspaceId;
  }

  public async runGroupWorkflowScheduler(
    assetGroupWorkflowId: string,
    jobRunType: JobRunType,
    workspaceId: string,
    repeatJobKey?: string,
  ): Promise<DefaultMessageResponseDto> {
    // Get the asset group workflow to access the workflow and asset group.
    // The run executes under `workflow.workspace`, so constrain the lookup to the
    // caller's workspace — otherwise any member could launch another tenant's
    // workflow against that tenant's assets.
    const assetGroupWorkflow = await this.assetGroupWorkflowRepo
      .createQueryBuilder('assetGroupWorkflow')
      .innerJoinAndSelect('assetGroupWorkflow.workflow', 'workflow')
      .leftJoinAndSelect('workflow.workspace', 'workspace')
      .addSelect('assetGroup.archivedAt')
      .innerJoinAndSelect('assetGroupWorkflow.assetGroup', 'assetGroup')
      .where('assetGroupWorkflow.id = :assetGroupWorkflowId', {
        assetGroupWorkflowId,
      })
      .andWhere('workspace.id = :workspaceId', { workspaceId })
      .andWhere('assetGroup.workspaceId = :workspaceId', { workspaceId })
      .getOne();

    if (!assetGroupWorkflow) {
      throw new NotFoundException(
        `Asset group workflow with ID "${assetGroupWorkflowId}" not found`,
      );
    }

    if (assetGroupWorkflow.assetGroup.archivedAt) throw new ProjectArchivedException();
    const workflow = assetGroupWorkflow.workflow;
    const assetGroupName = assetGroupWorkflow.assetGroup.name;

    // Get all assets associated with the specific asset group workflow
    const assets = await this.assetRepo
      .createQueryBuilder('assets')
      .innerJoin('project_assets', 'aga', 'aga."assetId" = assets.id')
      .innerJoin('projects', 'ag', 'ag.id = aga."projectId"')
      .innerJoin('project_workflows', 'agw', 'agw."projectId" = ag.id')
      .where('agw.id = :assetGroupWorkflowId', { assetGroupWorkflowId })
      .getMany();

    if (assets.length === 0) {
      throw new BadRequestException(
        'Asset group workflow does not have any assets associated with it.',
      );
    }

    // Every root step must be installed before the run starts: a run whose
    // first step silently fails is worse than a clear 400 here.
    await this.assertWorkflowRootToolsInstalled(workflow);

    const input: StartRunInput = {
      workflow, workspaceId, jobName: assetGroupName, jobRunType,
      assetIds: assets.map(asset => asset.id), projectId: assetGroupWorkflow.assetGroup.id, projectWorkflowId: assetGroupWorkflow.id,
    };
    await this.workflowRunnerService.startRun(input, async manager => {
      const locked = await lockProjectWorkflow(manager, assetGroupWorkflow.assetGroup.id, workspaceId, assetGroupWorkflowId);
      if (locked.workflow.id !== workflow.id || JSON.stringify(locked.workflow.content) !== JSON.stringify(workflow.content)) throw new BadRequestException('Workflow changed before launch');
      if (repeatJobKey && (locked.binding.jobId !== repeatJobKey || locked.binding.schedule === 'disabled')) throw new NotFoundException('Stale project schedule');
      const scope = await manager.query<{ id: string }[]>('SELECT a.id FROM project_assets pa JOIN assets a ON a.id=pa."assetId" JOIN targets t ON t.id=a."targetId" WHERE pa."projectId"=$1 AND t."workspaceId"=$2 AND a."isEnabled"=true ORDER BY a.id FOR SHARE OF a,t', [assetGroupWorkflow.assetGroup.id, workspaceId]);
      if (!scope.length) throw new BadRequestException('No eligible project assets');
      input.assetIds = scope.map(asset => asset.id);
    });

    return {
      message: `Run scheduler for asset group workflow with ID ${assetGroupWorkflowId}`,
    };
  }

  /**
   * Requires every root step's tool (a step without `needs`) to be installed in
   * the workspace. Steps reached later through `needs` are resolved by the
   * workflow runner, which fails the step and skips its dependents.
   */
  private async assertWorkflowRootToolsInstalled(
    workflow: Workflow,
  ): Promise<void> {
    const graph = buildWorkflowGraph(workflow.content);
    const rootToolNames = [
      ...new Set(
        graph.steps
          .filter((step) => step.needs.length === 0)
          .map((step) => step.run),
      ),
    ];
    if (rootToolNames.length === 0) return;

    const tools = await this.toolsService.getToolByNames({
      names: rootToolNames,
      isInstalled: true,
    });
    const installed = new Set(tools.map((tool) => tool.name));
    const missing = rootToolNames.find((name) => !installed.has(name));

    if (missing) {
      throw new BadRequestException(
        `Tool "${missing}" is not installed in the workspace.`,
      );
    }
  }

  /**
   * Removes the BullMQ repeat scheduler for an asset group workflow whose
   * group/workflow no longer resolves in the DB (orphaned schedule).
   * Used by the schedule consumer so stale jobs stop being queued.
   */
  async removeGroupWorkflowScheduler(
    repeatJobKey: string | null | undefined,
  ): Promise<void> {
    if (!repeatJobKey) {
      return;
    }
    await this.scanScheduleQueue.removeJobScheduler(repeatJobKey);
  }
}
