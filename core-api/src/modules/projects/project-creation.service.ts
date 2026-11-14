import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import { AssetGroupService } from '../asset-group/asset-group.service';
import { AssetGroup } from '../asset-group/entities/asset-groups.entity';
import { buildPipelineJobs } from '../asset-group/pipeline';
import { Tool } from '../tools/entities/tools.entity';
import { Workflow } from '../workflows/entities/workflow.entity';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import type { CreateProjectDto } from './dto/project-metadata-input.dto';
import type {
  ProjectCreatedDto,
  ProjectCreationOutcomeDto,
} from './dto/project-create-response.dto';
import type { CreatedProjectWorkflowDto } from './dto/project-workflow-create.dto';
import { ProjectScopeRule } from './entities/project-scope-rule.entity';
import { ProjectScopeNormalizer } from './project-scope-normalizer.service';
import { syncProjectScope } from './project-scope-sync';
import { ProjectMetadataReadService } from './project-metadata-read.service';
import { ProjectWorkflowCreateService } from './project-workflow-create.service';
import { ProjectWorkflowJobsService } from './project-workflow-jobs.service';
import { ProjectWorkflowActionsService } from './project-workflow-actions.service';
import { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';
import { triggersOfInput } from './project-workflow-on-input';
import type { ProjectWorkflowOnDto } from './dto/project-workflow-on.dto';
import { WorkflowOnError } from './project-workflow-on';

const enrichedKeys = [
  'scopeRules',
  'template',
  'jobs',
  'workflowName',
  'on',
  'runNow',
] as const;

/** Create setup atomically; external launch/scheduler recovery never deletes saved work. */
@Injectable()
export class ProjectCreationService {
  private readonly logger = new Logger(ProjectCreationService.name);
  constructor(
    private readonly db: DataSource,
    private readonly legacy: AssetGroupService,
    private readonly metadata: ProjectMetadataReadService,
    private readonly scope: ProjectScopeNormalizer,
    private readonly workflows: ProjectWorkflowCreateService,
    private readonly jobs: ProjectWorkflowJobsService,
    private readonly encryption: WorkspaceEncryptionService,
    private readonly actions: ProjectWorkflowActionsService,
    private readonly runtime: ProjectTriggerRuntimeService,
  ) {}

  async create(
    dto: CreateProjectDto,
    workspaceId: string,
    canLaunch: boolean,
  ): Promise<ProjectCreatedDto> {
    if (!enrichedKeys.some((key) => dto[key] !== undefined)) {
      const saved = await this.legacy.create(dto, workspaceId, dto);
      return this.metadata.getById(saved.id, workspaceId);
    }
    const inputs =
      dto.tools ?? dto.toolIds?.map((toolId) => ({ toolId })) ?? [];
    const hasPipeline =
      inputs.length > 0 || dto.template !== undefined || dto.jobs !== undefined;
    if (
      [
        inputs.length > 0,
        dto.template !== undefined,
        dto.jobs !== undefined,
      ].filter(Boolean).length > 1
    )
      throw new BadRequestException('Provide one initial pipeline source');
    if (
      !hasPipeline &&
      (dto.on !== undefined ||
        dto.workflowName !== undefined ||
        dto.runNow ||
        (dto.schedule && dto.schedule !== 'disabled'))
    )
      throw new BadRequestException(
        'Trigger, workflow name and run-now settings require a pipeline',
      );
    const on: ProjectWorkflowOnDto | undefined =
      dto.on ??
      (dto.schedule && dto.schedule !== 'disabled'
        ? { schedule: [{ cron: dto.schedule, enabled: true }] }
        : undefined);
    if (on !== undefined) {
      try {
        triggersOfInput(on);
      } catch (error) {
        if (error instanceof WorkflowOnError)
          throw new BadRequestException(error.message);
        throw error;
      }
    }
    if (
      !canLaunch &&
      (dto.runNow ||
        on?.schedule?.some((t) => t.enabled) ||
        on?.events?.some((t) => t.enabled))
    )
      throw new ForbiddenException(
        'Workflow write access is required to launch or enable triggers',
      );
    const name = dto.name.trim();
    if (
      !name ||
      name.includes('\u0000') ||
      [dto.description, dto.instruction].some((v) => v?.includes('\u0000'))
    )
      throw new BadRequestException('Invalid project metadata');
    // Resolve keys before holding the workspace lock or a pooled connection.
    const dek = hasPipeline ? await this.encryption.getDEK(workspaceId) : null;
    const setup = await this.db.transaction(async (manager) => {
      const workspace = await manager.query<{ id: string }[]>(
        'SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',
        [workspaceId],
      );
      if (!workspace.length) throw new NotFoundException('Workspace not found');
      if (
        await manager.exists(AssetGroup, {
          where: { name, workspace: { id: workspaceId } },
        })
      )
        throw new BadRequestException(
          'A project with this name already exists in this workspace',
        );
      const rules = await this.scope.normalizeRules(
        workspaceId,
        dto.scopeRules ?? [],
        manager,
      );
      const manual = [
        ...new Set((dto.hostIds ?? []).map((id) => id.toLowerCase())),
      ];
      if (manual.length) {
        const owned = await manager.query<{ id: string }[]>(
          `SELECT a.id FROM assets a JOIN targets t ON t.id=a."targetId"
          WHERE t."workspaceId"=$1 AND a.id=ANY($2::uuid[]) ORDER BY a.id FOR SHARE OF a,t`,
          [workspaceId, manual],
        );
        if (owned.length !== manual.length)
          throw new BadRequestException('Asset not found in this workspace');
      }
      const project = await manager.save(AssetGroup, {
        name,
        workspace: { id: workspaceId },
        hexColor: dto.hexColor,
        description: dto.description?.trim() || null,
        instruction: dto.instruction?.trim() || null,
        autoAddAssets: dto.autoAddAssets ?? true,
      });
      if (manual.length)
        await manager.query(
          `INSERT INTO project_assets("projectId","assetId",source)
        SELECT $1,id,'manual' FROM unnest($2::uuid[]) id`,
          [project.id, manual],
        );
      if (rules.length)
        await manager.save(
          ProjectScopeRule,
          rules.map((rule) => ({ ...rule, projectId: project.id })),
        );
      await syncProjectScope(manager, project.id, workspaceId);
      let binding: CreatedProjectWorkflowDto | undefined;
      if (hasPipeline) {
        const selected =
          dto.jobs ??
          (inputs.length ? await this.toolJobs(manager, inputs) : undefined);
        binding = await this.workflows.createWithin(
          manager,
          project.id,
          workspaceId,
          {
            ...(selected ? { jobs: selected } : { template: dto.template }),
            name: dto.workflowName?.trim(),
            on,
          },
          dek,
        );
        // Authored defaults are copied by the existing service. Validate their
        // references too, retaining stored encrypted config in this workspace.
        if (!selected) {
          const workflow = await manager.findOneByOrFail(Workflow, {
            id: binding.workflowId,
          });
          const prepared = await this.jobs.prepare(
            manager,
            workspaceId,
            workflow.content.jobs,
            workflow.content.jobs,
            dek,
            { preserveOnlyCiphertext: true },
          );
          await manager.save(Workflow, {
            ...workflow,
            content: { ...workflow.content, jobs: prepared },
          });
        }
      }
      return { id: project.id, binding };
    });
    const creation: ProjectCreationOutcomeDto = {};
    if (dto.runNow && setup.binding) {
      try {
        const [{ count }] = await this.db.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM project_assets pa
        JOIN assets a ON a.id=pa."assetId" JOIN targets t ON t.id=a."targetId"
        WHERE pa."projectId"=$1 AND t."workspaceId"=$2 AND a."isEnabled"=true`,
          [setup.id, workspaceId],
        );
        if (!count) creation.initialRun = { status: 'empty_scope' };
        else {
          const run = await this.actions.run(
            setup.id,
            workspaceId,
            setup.binding.id,
            {},
          );
          creation.initialRun = {
            status: 'started',
            jobHistoryId: run.jobHistoryId,
          };
        }
      } catch {
        this.logger.warn('Initial project run failed; saved project retained');
        creation.initialRun = { status: 'failed' };
      }
    }
    if (on !== undefined) {
      try {
        await this.runtime.reconcile();
        creation.triggerSync = 'complete';
      } catch {
        this.logger.warn(
          'Project trigger synchronization deferred to periodic reconciliation',
        );
        creation.triggerSync = 'pending';
      }
    }
    return Object.assign(await this.metadata.getById(setup.id, workspaceId), {
      creation,
    });
  }

  /** Resolve the legacy stage/input/profile controls through the current graph validator. */
  private async toolJobs(
    manager: EntityManager,
    inputs: NonNullable<CreateProjectDto['tools']>,
  ) {
    if (inputs.length > 50)
      throw new BadRequestException('Pipeline must contain 1–50 tools');
    const ids = [...new Set(inputs.map((input) => input.toolId.toLowerCase()))];
    const tools = await manager.find(Tool, { where: { id: In(ids) } });
    if (tools.length !== ids.length)
      throw new NotFoundException('Tool not found');
    const byId = new Map(tools.map((tool) => [tool.id!, tool.name]));
    const jobs = buildPipelineJobs(
      inputs.map(({ toolId, ...input }) => ({
        ...input,
        run: byId.get(toolId.toLowerCase())!,
      })),
    );
    if (Object.keys(jobs).length !== inputs.length)
      throw new BadRequestException('Duplicate pipeline tool/category');
    return jobs;
  }
}
