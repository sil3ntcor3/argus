import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { IdQueryParamDto } from '@/common/dtos/id-query-param.dto';
import { GetManyResponseDto } from '@/utils/getManyResponse';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssetGroupService } from '../asset-group/asset-group.service';
import { GetAllAssetGroupsQueryDto } from '../asset-group/dto/get-all-asset-groups-dto.dto';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import { PublishEvent } from '../event-bridge/publishing/publish-event.decorator';
import { ProjectMetadataReadService } from './project-metadata-read.service';
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

/** Canonical CRUD shares the existing tenant-scoped services and persistence. */
@ApiTags('Projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: AssetGroupService,
    private readonly metadata: ProjectMetadataReadService,
    private readonly scopePreview: ProjectScopePreviewService,
    private readonly scopeRead: ProjectScopeReadService,
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

  @Doc({
    summary: 'Create project',
    response: { serialization: ProjectViewDto, httpStatus: HttpStatus.CREATED },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.asset_group.created, {
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
  @PublishEvent(EVENT_CATALOG.asset_group.deleted)
  @WorkspaceAccess('project.write')
  @Delete(':id')
  delete(@Param() { id }: IdQueryParamDto, @WorkspaceId() workspaceId: string) {
    return this.projects.delete(id, workspaceId);
  }
}
