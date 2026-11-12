import { ProjectTriggerReadService } from './project-trigger-read.service';
import { CreateProjectTriggerDto } from './dto/project-trigger-create.dto';
import { ProjectTriggerCreateService } from './project-trigger-create.service';
import { ProjectTriggerCreatePipe } from './project-trigger-create.pipe';
import { ProjectTriggerDto } from './dto/project-trigger-read.dto';
import { WORKSPACE_HEADER_NAME } from '@/common/constants/app.constants';
import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { ProjectChange } from '@/common/enums/enum';
import { Doc } from '@/common/doc/doc.decorator';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { IdQueryParamDto } from '@/common/dtos/id-query-param.dto';
import { GetManyResponseDto } from '@/utils/getManyResponse';
import {
  GetManyBaseQueryParams,
  type GetManyBaseResponseDto,
} from '@/common/dtos/get-many-base.dto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AssetGroupService } from '../asset-group/asset-group.service';
import { AssetGroupAssetService } from '../asset-group/asset-group-asset.service';
import { Asset } from '../assets/entities/assets.entity';
import { GetAllAssetGroupsQueryDto } from '../asset-group/dto/get-all-asset-groups-dto.dto';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import { PublishEvent } from '../event-bridge/publishing/publish-event.decorator';
import { ProjectMetadataReadService } from './project-metadata-read.service';
import { ProjectWorkflowTemplatesService } from './project-workflow-templates.service';
import { AssetGroupWorkflow } from '../asset-group/entities/asset-groups-workflows.entity';
import { UpdateProjectWorkflowDto } from './dto/project-workflow-update.dto';
import { ProjectWorkflowUpdateService } from './project-workflow-update.service';
import { ProjectWorkflowCreateService } from './project-workflow-create.service';
import { CreatedProjectWorkflowDto, CreateProjectWorkflowDto } from './dto/project-workflow-create.dto';
import { WorkflowTemplateDto } from './dto/project-workflow-template.dto';
import { GetProjectRunsQueryDto, ProjectRunDto } from './dto/project-runs.dto';
import { ProjectRunReadService } from './project-run-read.service';
import { ProjectFindingReadService } from './project-finding-read.service';
import { ProjectFindingTimelineService } from './project-finding-timeline.service';
import { ProjectFindingTimelineDto } from './dto/project-finding-timeline.dto';
import { ProjectOverviewReadService } from './project-overview-read.service';
import { ProjectOverviewDto } from './dto/project-overview.dto';
import {
  GetProjectFindingsQueryDto,
  ProjectFindingsResponseDto,
} from './dto/project-findings.dto';
import { ProjectViewDto } from './dto/project-view.dto';
import {
  CreateProjectDto,
  UpdateProjectDto,
} from './dto/project-metadata-input.dto';
import {
  ScopePreviewDto,
  ScopePreviewResultDto,
} from './dto/project-scope-preview.dto';
import { ProjectScopePreviewService } from './project-scope-preview.service';
import { ProjectScopeReadService } from './project-scope-read.service';
import { ProjectScopeDto } from './dto/project-scope.dto';
import { ReplaceScopeRulesDto, ScopeSyncResultDto } from './dto/project-scope-write.dto';
import { ProjectScopeWriteService } from './project-scope-write.service';
import { ProjectAssetsCommandService } from './project-assets-command.service';
import { ProjectAssetReadService } from './project-asset-read.service';
import { GetProjectAssetsQueryDto, ProjectAssetDto } from './dto/project-assets-read.dto';
import {
  AddProjectAssetsDto,
  RemoveProjectAssetsDto,
  ProjectAssetsChangedDto,
} from './dto/project-assets-command.dto';

/** Canonical CRUD shares the existing tenant-scoped services and persistence. */
@ApiTags('Projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: AssetGroupService,
    private readonly metadata: ProjectMetadataReadService,
    private readonly scopePreview: ProjectScopePreviewService,
    private readonly scopeRead: ProjectScopeReadService,
    private readonly scopeWrite: ProjectScopeWriteService,
    private readonly assetCommands: ProjectAssetsCommandService,
    private readonly candidateAssets: AssetGroupAssetService,
    private readonly assetRead: ProjectAssetReadService,
    private readonly triggerRead: ProjectTriggerReadService,
    private readonly triggerCreate: ProjectTriggerCreateService,
    private readonly workflowTemplates: ProjectWorkflowTemplatesService,
    private readonly workflowCreate: ProjectWorkflowCreateService,
    private readonly workflowUpdate: ProjectWorkflowUpdateService,
    private readonly runRead: ProjectRunReadService,
    private readonly findingRead: ProjectFindingReadService,
    private readonly findingTimeline: ProjectFindingTimelineService,
    private readonly overviewRead: ProjectOverviewReadService,
  ) {}

  @Doc({
    summary: 'List projects',
    response: { serialization: GetManyResponseDto(ProjectViewDto) },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.read')
  @Get()
  getMany(
    @Query() query: GetAllAssetGroupsQueryDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.metadata.getMany(query, workspaceId);
  }

  @ApiOperation({
    summary: 'Workflow templates',
    description: 'Default workspace workflows with tool names and dependency outlines.',
  })
  @ApiHeader({ name: WORKSPACE_HEADER_NAME, description: 'Workspace ID' })
  @ApiOkResponse({ type: [WorkflowTemplateDto] })
  @WorkspaceAccess('project.read')
  @Get('workflow-templates')
  getWorkflowTemplates(@WorkspaceId() workspaceId: string) {
    return this.workflowTemplates.list(workspaceId);
  }

  @Doc({
    summary: 'List project workflow triggers',
    response: { serialization: ProjectTriggerDto, isArray: true },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.read')
  @Get(':id/triggers')
  getTriggers(@Param() { id }: IdQueryParamDto, @WorkspaceId() workspaceId: string) {
    return this.triggerRead.list(id, workspaceId);
  }

  @Doc({
    summary: 'Create a disabled project workflow trigger',
    response: { serialization: ProjectTriggerDto, httpStatus: HttpStatus.CREATED },
    request: { getWorkspaceId: true },
  })
  @ApiBody({ type: CreateProjectTriggerDto })
  @PublishEvent(EVENT_CATALOG.project.updated, {
    resourceIdFromRoute: true,
    metadata: () => ({ change: ProjectChange.TRIGGERS }),
  })
  @WorkspaceAccess('project.write')
  @Post(':id/triggers')
  createTrigger(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
    // Keep the original body for strict validation; the global pipe skips unknown.
    @Body(new ProjectTriggerCreatePipe()) body: unknown,
  ) {
    return this.triggerCreate.create(id, workspaceId, body as CreateProjectTriggerDto);
  }

  @Doc({
    summary: 'Create a project workflow from a template, selected jobs or another project binding',
    response: { serialization: CreatedProjectWorkflowDto, httpStatus: HttpStatus.CREATED },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.updated, {
    resourceIdFromRoute: true,
    metadata: (_body, result) => ({
      change: ProjectChange.WORKFLOW_ADDED,
      ...(result ? { workflow: (result as CreatedProjectWorkflowDto).name } : {}),
    }),
  })
  @WorkspaceAccess('project.write')
  @Post(':id/workflows')
  createWorkflow(
    @Param() { id }: IdQueryParamDto,
    @Body() dto: CreateProjectWorkflowDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.workflowCreate.create(id, workspaceId, dto);
  }

  @Doc({
    summary: 'Update a project workflow name, job graph, or both',
    response: { serialization: AssetGroupWorkflow },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.updated, {
    resourceIdFromRoute: true,
    metadata: (_body, result) => ({
      change: ProjectChange.WORKFLOW_UPDATED,
      ...(result ? { workflow: (result as AssetGroupWorkflow).workflow.name } : {}),
    }),
  })
  @WorkspaceAccess('project.write')
  @Patch(':id/workflows/:bindingId')
  updateWorkflow(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bindingId', ParseUUIDPipe) bindingId: string,
    @Body() dto: UpdateProjectWorkflowDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.workflowUpdate.update(id, workspaceId, bindingId, dto);
  }

  @Doc({
    summary: 'Create project',
    response: { serialization: ProjectViewDto, httpStatus: HttpStatus.CREATED },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.created, {
    resourceId: (result) => (result as ProjectViewDto | undefined)?.id,
    changes: (body) => ({
      name: { after: (body as { name?: string })?.name ?? '' },
    }),
  })
  @WorkspaceAccess('project.write')
  @Post()
  async create(
    @Body() dto: CreateProjectDto,
    @WorkspaceId() workspaceId: string,
  ) {
    const saved = await this.projects.create(dto, workspaceId, dto);
    return this.metadata.getById(saved.id, workspaceId);
  }

  @Doc({
    summary: 'Preview scope rules',
    response: {
      serialization: ScopePreviewResultDto,
      httpStatus: HttpStatus.OK,
    },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.read')
  @HttpCode(HttpStatus.OK)
  @Post('scope-preview')
  previewScope(
    @Body() dto: ScopePreviewDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.scopePreview.preview(workspaceId, dto.rules, dto.projectId);
  }

  @Doc({
    summary: 'Get project scope rules',
    response: { serialization: ProjectScopeDto },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.read')
  @Get(':id/scope-rules')
  getScopeRules(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.scopeRead.getScope(id, workspaceId);
  }

  @Doc({
    summary: 'Replace project scope rules',
    response: { serialization: ScopeSyncResultDto },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.updated, {
    resourceIdFromRoute: true,
    metadata: (_body, result) => ({
      change: ProjectChange.SCOPE,
      ...(result ? { added: (result as ScopeSyncResultDto).added, removed: (result as ScopeSyncResultDto).removed } : {}),
    }),
  })
  @WorkspaceAccess('project.write')
  @Put(':id/scope-rules')
  async replaceScopeRules(
    @Param() { id }: IdQueryParamDto,
    @Body() dto: ReplaceScopeRulesDto,
    @WorkspaceId() workspaceId: string,
  ): Promise<ScopeSyncResultDto> {
    const result = await this.scopeWrite.replaceRules(id, workspaceId, dto.rules, dto.autoAddAssets);
    return { added: result.added.length, removed: result.removed };
  }

  @Doc({
    summary: 'Add assets to project',
    response: {
      serialization: ProjectAssetsChangedDto,
      httpStatus: HttpStatus.CREATED,
    },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.updated, {
    resourceIdFromRoute: true,
    metadata: (_body, result) => ({
      change: ProjectChange.ASSETS_ADDED,
      ...(result ? { added: (result as ProjectAssetsChangedDto).count } : {}),
    }),
  })
  @WorkspaceAccess('project.write')
  @Post(':id/assets')
  addAssets(
    @Param() { id }: IdQueryParamDto,
    @Body() dto: AddProjectAssetsDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.assetCommands.add(id, workspaceId, dto.assetIds);
  }

  @Doc({
    summary: 'Remove assets from project',
    response: {
      serialization: ProjectAssetsChangedDto,
      httpStatus: HttpStatus.OK,
    },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.updated, {
    resourceIdFromRoute: true,
    metadata: (_body, result) => ({
      change: ProjectChange.ASSETS_REMOVED,
      ...(result ? { removed: (result as ProjectAssetsChangedDto).count } : {}),
    }),
  })
  @WorkspaceAccess('project.write')
  @Delete(':id/assets')
  removeAssets(
    @Param() { id }: IdQueryParamDto,
    @Body() dto: RemoveProjectAssetsDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.assetCommands.remove(id, workspaceId, dto.assetIds);
  }

  @Doc({
    summary: 'Project assets',
    response: { serialization: GetManyResponseDto(ProjectAssetDto) },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.read')
  @Get(':id/assets')
  getAssets(
    @Param() { id }: IdQueryParamDto,
    @Query() query: GetProjectAssetsQueryDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.assetRead.list(id, workspaceId, query);
  }

  @Doc({
    summary: 'Asset candidates',
    response: { serialization: GetManyResponseDto(Asset) },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.read')
  @Get(':id/assets/candidates')
  getAssetCandidates(
    @Param() { id }: IdQueryParamDto,
    @Query() query: GetManyBaseQueryParams,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.candidateAssets.getAssetsNotInAssetGroup(id, query, workspaceId);
  }

  @ApiOperation({
    summary: 'Project runs',
    description: 'Attributed runs, newest first, with step and finding counts.',
  })
  @ApiHeader({ name: WORKSPACE_HEADER_NAME, description: 'Workspace ID' })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: GetManyResponseDto(ProjectRunDto) })
  @WorkspaceAccess('project.read')
  @Get(':id/runs')
  getRuns(
    @Param() { id }: IdQueryParamDto,
    @Query() query: GetProjectRunsQueryDto,
    @WorkspaceId() workspaceId: string,
  ): Promise<GetManyBaseResponseDto<ProjectRunDto>> {
    return this.runRead.list(id, workspaceId, query);
  }

  @ApiOperation({
    summary: 'Project findings',
    description: 'Attributed findings with sightings, provenance and filter counts.',
  })
  @ApiHeader({ name: WORKSPACE_HEADER_NAME, description: 'Workspace ID' })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: ProjectFindingsResponseDto })
  @WorkspaceAccess('project.read')
  @Get(':id/vulnerabilities')
  getFindings(
    @Param() { id }: IdQueryParamDto,
    @Query() query: GetProjectFindingsQueryDto,
    @WorkspaceId() workspaceId: string,
  ): Promise<ProjectFindingsResponseDto> {
    return this.findingRead.list(id, workspaceId, query);
  }

  @ApiOperation({
    summary: 'Project finding timeline',
    description:
      'Project runs with confirmed, missed or unknown sightings for a finding.',
  })
  @ApiHeader({ name: WORKSPACE_HEADER_NAME, description: 'Workspace ID' })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({
    name: 'vulnerabilityId',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: ProjectFindingTimelineDto })
  @WorkspaceAccess('project.read')
  @Get(':id/vulnerabilities/:vulnerabilityId/timeline')
  getFindingTimeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vulnerabilityId', ParseUUIDPipe) vulnerabilityId: string,
    @WorkspaceId() workspaceId: string,
  ): Promise<ProjectFindingTimelineDto> {
    return this.findingTimeline.read(id, workspaceId, vulnerabilityId);
  }

  @ApiOperation({
    summary: 'Project overview',
    description:
      'Project counts, weekly finding trends, run summaries and recent activity.',
  })
  @ApiHeader({ name: WORKSPACE_HEADER_NAME, description: 'Workspace ID' })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: ProjectOverviewDto })
  @WorkspaceAccess('project.read')
  @Get(':id/overview')
  getOverview(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
  ): Promise<ProjectOverviewDto> {
    return this.overviewRead.read(id, workspaceId);
  }

  @Doc({
    summary: 'Get project by ID',
    response: { serialization: ProjectViewDto },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.read')
  @Get(':id')
  getById(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.metadata.getById(id, workspaceId);
  }

  @Doc({
    summary: 'Update project',
    response: { serialization: ProjectViewDto },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.updated, {
    resourceIdFromRoute: true,
    metadata: () => ({ change: ProjectChange.SETTINGS }),
  })
  @WorkspaceAccess('project.write')
  @Patch(':id')
  async update(
    @Param() { id }: IdQueryParamDto,
    @Body() dto: UpdateProjectDto,
    @WorkspaceId() workspaceId: string,
  ) {
    const saved = await this.projects.updateAssetGroupById(
      id,
      dto,
      workspaceId,
      dto,
    );
    return this.metadata.getById(saved.id, workspaceId);
  }

  // The ES5 test transform renames reserved method names; keep the contract stable.
  @ApiOperation({
    operationId: 'ProjectsController_delete',
    summary: 'Delete project',
  })
  @Doc({
    summary: 'Delete project',
    response: { serialization: DefaultMessageResponseDto },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.project.deleted, { resourceIdFromRoute: true })
  @WorkspaceAccess('project.write')
  @Delete(':id')
  delete(@Param() { id }: IdQueryParamDto, @WorkspaceId() workspaceId: string) {
    return this.projects.delete(id, workspaceId);
  }
}
