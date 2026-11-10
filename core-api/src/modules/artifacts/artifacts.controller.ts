import { UserContext } from '@/common/decorators/app.decorator';
import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import { IdQueryParamDto } from '@/common/dtos/id-query-param.dto';
import type { RequestWithMetadata, UserContextPayload } from '@/common/interfaces/app.interface';
import { GetManyResponseDto } from '@/utils/getManyResponse';
import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import { ArtifactReadService } from './artifact-read.service';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactListItemDto, ArtifactListQueryDto } from './dto/artifact-list.dto';
import { ArtifactUsageDto } from './dto/artifact-usage.dto';

@ApiTags('Artifacts')
@Controller('artifacts')
export class ArtifactsController {
  constructor(
    private readonly usage: ArtifactUsageService,
    private readonly files: ArtifactReadService,
  ) {}

  @Doc({
    summary: 'List workspace files',
    description: 'Lists ready files in the selected workspace. Scope mine lists files created by the caller. Scope all also requires artifact.manage.',
    response: { serialization: GetManyResponseDto(ArtifactListItemDto) },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('artifact.read')
  @Header('Cache-Control', 'private, no-store')
  @Get()
  getMany(
    @Query() query: ArtifactListQueryDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
    @Req() request: RequestWithMetadata,
  ) {
    return this.files.getMany(workspaceId, user.id, query, request.permissions ?? []);
  }

  @Doc({
    summary: 'Get workspace storage usage',
    description: 'Returns quota, used and reserved bytes, and the per-file limit. Requires artifact.read.',
    response: { serialization: ArtifactUsageDto },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('artifact.read')
  @Header('Cache-Control', 'private, no-store')
  @Get('usage')
  getUsage(@WorkspaceId() workspaceId: string): Promise<ArtifactUsageDto> {
    return this.usage.getUsage(workspaceId);
  }

  @Doc({
    summary: 'Get workspace file metadata',
    description: 'Returns metadata for a ready file in the selected workspace. Reading another creator’s file also requires artifact.manage.',
    response: { serialization: ArtifactListItemDto },
    request: {
      getWorkspaceId: true,
      params: [{ name: 'id', schema: { type: 'string', format: 'uuid' } }],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid file ID or workspace selection.' })
  @ApiNotFoundResponse({ description: 'File not found in the selected workspace.' })
  @WorkspaceAccess('artifact.read')
  @Header('Cache-Control', 'private, no-store')
  @Get(':id')
  getById(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
    @Req() request: RequestWithMetadata,
  ): Promise<ArtifactListItemDto> {
    return this.files.getById(workspaceId, user.id, id, request.permissions ?? []);
  }
}
