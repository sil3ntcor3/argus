import { UserContext } from '@/common/decorators/app.decorator';
import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import type { RequestWithMetadata, UserContextPayload } from '@/common/interfaces/app.interface';
import { GetManyResponseDto } from '@/utils/getManyResponse';
import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArtifactListService } from './artifact-list.service';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactListItemDto, ArtifactListQueryDto } from './dto/artifact-list.dto';
import { ArtifactUsageDto } from './dto/artifact-usage.dto';

@ApiTags('Artifacts')
@Controller('artifacts')
export class ArtifactsController {
  constructor(
    private readonly usage: ArtifactUsageService,
    private readonly files: ArtifactListService,
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
}
