import { UserContext } from '@/common/decorators/app.decorator';
import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import { IdQueryParamDto } from '@/common/dtos/id-query-param.dto';
import type { UserContextPayload } from '@/common/interfaces/app.interface';
import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import { ArtifactFoldersService } from './artifact-folders.service';
import { ArtifactFolderDetailDto, ArtifactFolderDto, ArtifactFolderQueryDto } from './dto/artifact-folder.dto';

@ApiTags('Artifacts')
@Controller('artifact-folders')
@WorkspaceAccess('artifact.read')
export class ArtifactFoldersController {
  constructor(private readonly folders: ArtifactFoldersService) {}

  @Doc({
    summary: 'List personal artifact folders',
    description: 'Lists folders owned by the caller directly under the selected parent or at the workspace root.',
    response: { serialization: ArtifactFolderDto, isArray: true },
    request: { getWorkspaceId: true },
  })
  @ApiBadRequestResponse({ description: 'Invalid parent folder ID or workspace selection.' })
  @ApiNotFoundResponse({ description: 'Parent folder not found.' })
  @Header('Cache-Control', 'private, no-store')
  @Get()
  getMany(
    @Query() { parentFolderId }: ArtifactFolderQueryDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
  ): Promise<ArtifactFolderDto[]> {
    return this.folders.getMany(workspaceId, user.id, parentFolderId);
  }

  @Doc({
    summary: 'Get a personal artifact folder',
    description: 'Returns an owned folder and its breadcrumb in the selected workspace.',
    response: { serialization: ArtifactFolderDetailDto },
    request: {
      getWorkspaceId: true,
      params: [{ name: 'id', schema: { type: 'string', format: 'uuid' } }],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid folder ID or workspace selection.' })
  @ApiNotFoundResponse({ description: 'Folder not found.' })
  @Header('Cache-Control', 'private, no-store')
  @Get(':id')
  getById(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
  ): Promise<ArtifactFolderDetailDto> {
    return this.folders.getById(workspaceId, user.id, id);
  }
}
