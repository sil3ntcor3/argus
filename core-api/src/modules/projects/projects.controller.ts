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
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssetGroupService } from '../asset-group/asset-group.service';
import { CreateAssetGroupDto } from '../asset-group/dto/create-asset-group.dto';
import { GetAllAssetGroupsQueryDto } from '../asset-group/dto/get-all-asset-groups-dto.dto';
import { UpdateAssetGroupDto } from '../asset-group/dto/update-asset-group.dto';
import { AssetGroup } from '../asset-group/entities/asset-groups.entity';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import { PublishEvent } from '../event-bridge/publishing/publish-event.decorator';
import { ProjectMetadataReadService } from './project-metadata-read.service';
import { ProjectViewDto } from './dto/project-view.dto';

/** Canonical CRUD shares the existing tenant-scoped services and persistence. */
@ApiTags('Projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: AssetGroupService,
    private readonly metadata: ProjectMetadataReadService,
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
    response: { serialization: AssetGroup, httpStatus: HttpStatus.CREATED },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.asset_group.created, {
    changes: (body) => ({
      name: { after: (body as { name?: string })?.name ?? '' },
    }),
  })
  @WorkspaceAccess('project.write')
  @Post()
  create(@Body() dto: CreateAssetGroupDto, @WorkspaceId() workspaceId: string) {
    return this.projects.create(dto, workspaceId);
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
    response: { serialization: AssetGroup },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('project.write')
  @Patch(':id')
  update(
    @Param() { id }: IdQueryParamDto,
    @Body() dto: UpdateAssetGroupDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.projects.updateAssetGroupById(id, dto, workspaceId);
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
