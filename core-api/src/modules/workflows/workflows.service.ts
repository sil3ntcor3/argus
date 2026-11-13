import { isGroupOwnedWorkflow } from '../asset-group/workflow-ownership';
import { ProjectArchivedException } from '../projects/project-archive-state';
import { GetManyBaseResponseDto } from '@/common/dtos/get-many-base.dto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Tool } from '../tools/entities/tools.entity';
import { resolveToolCategory } from '../tools/tool-categories';
import type { ToolCategorySpec } from '../tools/tool-categories';
import { resolveStepInputs } from '../tools/tool-io';
import {
  resolveToolTargetTypes,
  triggerTargetType,
} from '../tools/tool-target-types';
import { Workflow, WorkflowContent } from './entities/workflow.entity';
import { User } from '../auth/entities/user.entity';
import { Workspace } from '../workspaces/entities/workspace.entity';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { GetManyWorkflowsQueryDto } from './dto/get-many-workflows.dto';
import {
  jobEntries,
  normalizeInput,
  normalizeWorkflowContent,
  WorkflowGraphError,
} from './workflow-graph';

const ALLOWED_WORKFLOW_SORT_FIELDS = ['createdAt', 'updatedAt', 'name'] as const;

@Injectable()
export class WorkflowsService {
  constructor(
    @InjectRepository(Workflow)
    public workflowRepository: Repository<Workflow>,
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
  ) {}

  private readonly logger = new Logger(WorkflowsService.name);

  /**
   * Creates a new workflow in the specified workspace
   * @param createWorkflowDto The data transfer object containing workflow details
   * @param createdBy The user creating the workflow
   * @param workspace The workspace where the workflow will be created
   * @returns The created Workflow entity
   */
  async createWorkflow(
    createWorkflowDto: CreateWorkflowDto,
    createdBy: { id: string },
    workspace: { id: string },
  ): Promise<Workflow> {
    const { name, content, filePath } = createWorkflowDto;

    const workflow = new Workflow();
    workflow.name = name;
    workflow.content = this.normalizeContent(content);
    await this.assertStepsCanRun(workflow.content);
    workflow.filePath =
      filePath || `${name.toLowerCase().replace(/\s+/g, '-')}.yaml`;
    workflow.createdBy = { id: createdBy.id } as User;
    workflow.workspace = { id: workspace.id } as Workspace;

    return await this.workflowRepository.save(workflow);
  }

  /**
   * Retrieves a specific workflow by its ID within a workspace
   * @param id The ID of the workflow to retrieve
   * @param workspace The workspace containing the workflow
   * @returns The Workflow entity if found
   * @throws Error if workflow is not found in the workspace
   */
  async getWorkspaceWorkflow(
    id: string,
    workspace: { id: string },
  ): Promise<Workflow> {
    const workflow = await this.workflowRepository.findOne({
      where: {
        id,
        workspace: { id: workspace.id },
      },
      relations: ['createdBy', 'workspace'],
    });

    if (!workflow) {
      throw new Error('Workflow not found in this workspace');
    }

    return workflow;
  }

  /**
   * Serializes generic saves and retains trigger-managed project definitions.
   * @param id The ID of the workflow to update
   * @param updateData The partial data to update
   * @param workspace The workspace containing the workflow
   * @returns The updated Workflow entity
   * @throws Error if workflow is not found in the workspace
   */
  async updateWorkflow(
    id: string,
    updateData: Partial<CreateWorkflowDto>,
    workspace: { id: string },
  ): Promise<Workflow> {
    return this.workflowRepository.manager.transaction(async (manager) => {
      await manager.query(
        'SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE',
        [workspace.id],
      );
      const workflow = await manager
        .getRepository(Workflow)
        .createQueryBuilder('workflow')
        .leftJoinAndSelect('workflow.workspace', 'workspace')
        .leftJoinAndSelect('workflow.createdBy', 'createdBy')
        .where('workflow.id = :id AND workflow."workspaceId" = :workspaceId', {
          id,
          workspaceId: workspace.id,
        })
        .setLock('pessimistic_write', undefined, ['workflow'])
        .getOne();
      if (!workflow) throw new Error('Workflow not found in this workspace');
      const owners = await manager.query<{ id: string; archivedAt: Date | null }[]>('SELECT p.id,p."archivedAt" FROM projects p JOIN project_workflows pw ON pw."projectId"=p.id WHERE pw."workflowId"=$1 AND p."workspaceId"=$2', [workflow.id, workspace.id]);
      if (owners.some(project => project.archivedAt && isGroupOwnedWorkflow(workflow, project.id))) throw new ProjectArchivedException();

      if (updateData.name) workflow.name = updateData.name;
      if (updateData.content) {
        const projects = await manager.query<{ projectId: string }[]>(
          `
          SELECT p.id AS "projectId" FROM project_workflows pw JOIN projects p ON p.id=pw."projectId"
          WHERE pw."workflowId"=$1 AND p."workspaceId"=$2 AND EXISTS (
            SELECT 1 FROM project_workflow_triggers t WHERE t."projectWorkflowId"=pw.id
          )`,
          [workflow.id, workspace.id],
        );
        // A project trigger association remains managed across filename changes.
        const managed = projects.length > 0;
        workflow.content = this.normalizeContent(
          managed
            ? { ...updateData.content, on: workflow.content.on }
            : updateData.content,
        );
        await this.assertStepsCanRun(
          workflow.content,
          manager.getRepository(Tool),
        );
      }
      if (updateData.filePath) workflow.filePath = updateData.filePath;
      return manager.save(Workflow, workflow);
    });
  }

  /**
   * Validates the step graph and returns it in its canonical stored shape
   * (`jobs` as a map keyed by job id). It also accepts the legacy array form —
   * the template loader and the asset-group workflow writer both normalize
   * before saving, so the database converges on one shape with no data
   * migration, and every read path goes through the tolerant graph helpers.
   *
   * Note this is not the HTTP boundary: the create/update DTO already requires
   * the map (`jobs` is an object), so a client still sending the legacy array is
   * rejected by validation before it reaches this method.
   *
   * @throws BadRequestException when the content is not a valid graph.
   */
  private normalizeContent(content: WorkflowContent): WorkflowContent {
    try {
      return normalizeWorkflowContent(content);
    } catch (error) {
      if (error instanceof WorkflowGraphError) {
        throw new BadRequestException(
          `Invalid workflow content: ${error.errors.join('; ')}`,
        );
      }
      throw error;
    }
  }

  /**
   * Rejects a workflow in which a job names a category its tool does not
   * declare, or in which a job's category can scan NONE of the target types its
   * triggers fire for (e.g. `subfinder` — domains only — in a workflow that only
   * triggers on `ip.create`): that job could never produce work.
   *
   * Partial overlap is allowed on purpose. A workflow triggered by both
   * `domain.create` and `ip.create` may still use `subfinder`; at run time
   * the job simply finds no eligible asset for an IP target and is skipped.
   * Workflows without target triggers (schedules, asset groups) only get the
   * category check — the same run-time filter covers their target types.
   *
   * @throws BadRequestException naming every offending job.
   */
  private async assertStepsCanRun(
    content: WorkflowContent,
    toolRepository: Repository<Tool> = this.toolRepository,
  ): Promise<void> {
    const triggerTypes = [
      ...new Set(
        (content.on?.target ?? [])
          .map(triggerTargetType)
          .filter((type) => type !== undefined),
      ),
    ];

    const jobs = jobEntries(content.jobs);
    const runs = [
      ...new Set(
        jobs.map(([, job]) => job.run).filter((run): run is string => !!run),
      ),
    ];
    if (runs.length === 0) return;

    // Unknown tools are not this check's concern: the run reports them.
    const tools = await toolRepository.find({
      where: { name: In(runs) },
      select: { name: true, categories: true },
    });
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

    const errors = jobs.flatMap(([, job]) => {
      const tool = job.run ? toolByName.get(job.run) : undefined;
      if (!tool) return [];
      let spec: ToolCategorySpec;
      try {
        spec = resolveToolCategory(tool, job.category);
        resolveStepInputs(tool.name, spec, normalizeInput(job.input));
      } catch (error) {
        return [(error as Error).message];
      }
      const supported = resolveToolTargetTypes(spec);
      return triggerTypes.length === 0 ||
        triggerTypes.some((type) => supported.includes(type))
        ? []
        : [
            `"${tool.name}" (${spec.name}) can only scan ${supported.join(', ')} targets but this workflow triggers on ${triggerTypes.join(', ')}`,
          ];
    });
    if (errors.length > 0) {
      throw new BadRequestException(
        `Invalid workflow content: ${errors.join('; ')}`,
      );
    }
  }

  /**
   * Deletes a workflow by its ID from the specified workspace
   * @param id The ID of the workflow to delete
   * @param workspace The workspace containing the workflow
   * @throws Error if workflow is not found in the workspace
   */
  async deleteWorkflow(id: string, workspace: { id: string }): Promise<void> {
    await this.workflowRepository.manager.transaction(async manager => {
      await manager.query('SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE', [workspace.id]);
      const workflow = await manager.getRepository(Workflow).createQueryBuilder('workflow').leftJoinAndSelect('workflow.workspace', 'workspace')
        .where('workflow.id=:id AND workflow."workspaceId"=:workspaceId', { id, workspaceId: workspace.id }).setLock('pessimistic_write', undefined, ['workflow']).getOne();
      if (!workflow) throw new Error('Workflow not found in this workspace');
      const owners = await manager.query<{ id: string; archivedAt: Date | null }[]>('SELECT p.id,p."archivedAt" FROM projects p JOIN project_workflows pw ON pw."projectId"=p.id WHERE pw."workflowId"=$1 AND p."workspaceId"=$2', [workflow.id, workspace.id]);
      if (owners.some(project => project.archivedAt && isGroupOwnedWorkflow(workflow, project.id))) throw new ProjectArchivedException();
      await manager.remove(Workflow, workflow);
    });
  }

  /**
   * Retrieves many workflows with pagination and filtering
   * @param query Query parameters for pagination, sorting, and filtering
   * @param workspaceId The workspace ID to filter workflows
   * @returns Paginated response with workflows data
   */
  async getManyWorkflows(
    query: GetManyWorkflowsQueryDto,
    workspaceId: string,
  ): Promise<GetManyBaseResponseDto<Workflow>> {
    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'ASC',
      name,
    } = query;

    const queryBuilder = this.workflowRepository
      .createQueryBuilder('workflow')
      .leftJoinAndSelect('workflow.createdBy', 'createdBy')
      .leftJoinAndSelect('workflow.workspace', 'workspace')
      .where('workflow.workspaceId = :workspaceId', { workspaceId });

    // Apply filters
    if (name) {
      queryBuilder.andWhere('workflow.name LIKE :name', { name: `%${name}%` });
    }

    // Apply sorting with whitelist to prevent SQL injection
    const safeSortBy = (
      ALLOWED_WORKFLOW_SORT_FIELDS as readonly string[]
    ).includes(sortBy)
      ? sortBy
      : 'createdAt';
    queryBuilder.orderBy(`workflow.${safeSortBy}`, sortOrder);

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    // Execute query
    const [data, total] = await queryBuilder.getManyAndCount();

    const pageCount = Math.ceil(total / limit);
    const hasNextPage = page < pageCount;

    return {
      data,
      total,
      page,
      limit,
      pageCount,
      hasNextPage,
    };
  }
}
