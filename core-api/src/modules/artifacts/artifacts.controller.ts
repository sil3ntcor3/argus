import { UserContext } from '@/common/decorators/app.decorator';
import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { IdQueryParamDto } from '@/common/dtos/id-query-param.dto';
import type { RequestWithMetadata, UserContextPayload } from '@/common/interfaces/app.interface';
import { GetManyResponseDto } from '@/utils/getManyResponse';
import { Body, Controller, Delete, Get, Header, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBadRequestResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import { ArtifactCleanupService } from './artifact-cleanup.service';
import { ArtifactReadService } from './artifact-read.service';
import { ArtifactShareService } from './artifact-share.service';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactDownloadDto } from './dto/artifact-download.dto';
import { ArtifactListCreatorDto, ArtifactListItemDto, ArtifactListQueryDto } from './dto/artifact-list.dto';
import { AddArtifactSharesDto, AddArtifactSharesResultDto, UpdateArtifactAccessDto } from './dto/artifact-share.dto';
import { ArtifactUsageDto } from './dto/artifact-usage.dto';

@ApiTags('Artifacts')
@Controller('artifacts')
export class ArtifactsController {
  constructor(
    private readonly usage: ArtifactUsageService,
    private readonly files: ArtifactReadService,
    private readonly cleanup: ArtifactCleanupService,
    private readonly shares: ArtifactShareService,
  ) {}

  @Doc({
    summary: 'List workspace files',
    description: 'Lists ready files in the selected workspace. Scope mine lists owned files. Scope shared lists other creators’ files shared with the current member. Scope all also requires artifact.manage.',
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
    description: 'Returns metadata for a ready file in the selected workspace. Owners, named current members of shared files, and artifact.manage holders can read metadata.',
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

  @Doc({
    summary: 'Get a workspace file download URL',
    description: 'Returns a five-minute attachment URL for a ready file in the selected workspace to its owner or a named current member when the file is shared.',
    response: { serialization: ArtifactDownloadDto },
    request: {
      getWorkspaceId: true,
      params: [{ name: 'id', schema: { type: 'string', format: 'uuid' } }],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid file ID or workspace selection.' })
  @ApiForbiddenResponse({ description: 'Missing file read access in the selected workspace.' })
  @ApiNotFoundResponse({ description: 'File not found in the selected workspace.' })
  @WorkspaceAccess('artifact.read')
  @Header('Cache-Control', 'private, no-store')
  @Get(':id/download')
  download(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
  ): Promise<ArtifactDownloadDto> {
    return this.files.getDownloadUrl(workspaceId, user.id, id);
  }

  @Doc({
    summary: 'List recipients for an owned workspace file',
    description: 'Lists current workspace members recorded as recipients of a ready file created by the caller.',
    response: { serialization: ArtifactListCreatorDto, isArray: true },
    request: {
      getWorkspaceId: true,
      params: [{ name: 'id', schema: { type: 'string', format: 'uuid' } }],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid file ID or workspace selection.' })
  @ApiForbiddenResponse({ description: 'Missing file write access in the selected workspace.' })
  @ApiNotFoundResponse({ description: 'Owned ready file not found in the selected workspace.' })
  @WorkspaceAccess('artifact.write')
  @Header('Cache-Control', 'private, no-store')
  @Get(':id/shares')
  getShares(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
  ): Promise<ArtifactListCreatorDto[]> {
    return this.files.getShares(workspaceId, user.id, id);
  }

  @Doc({
    summary: 'Add workspace file recipients',
    description: 'Adds current members of the selected workspace to the share list of a ready file owned by the caller.',
    response: { serialization: AddArtifactSharesResultDto, httpStatus: HttpStatus.CREATED },
    request: {
      getWorkspaceId: true,
      params: [{ name: 'id', schema: { type: 'string', format: 'uuid' } }],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid recipient list, file ID, or workspace selection.' })
  @ApiForbiddenResponse({ description: 'Missing file write access in the selected workspace.' })
  @ApiNotFoundResponse({ description: 'Owned ready file not found in the selected workspace.' })
  @WorkspaceAccess('artifact.write')
  @Header('Cache-Control', 'private, no-store')
  @Post(':id/shares')
  addShares(
    @Param() { id }: IdQueryParamDto,
    @Body() { emails }: AddArtifactSharesDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
  ): Promise<AddArtifactSharesResultDto> {
    return this.shares.addShares(workspaceId, user.id, id, emails);
  }

  @Doc({
    summary: 'Remove a workspace file recipient',
    description: 'Removes a recipient record from a ready file owned by the caller, including a former workspace member.',
    response: { serialization: DefaultMessageResponseDto },
    request: {
      getWorkspaceId: true,
      params: [
        { name: 'id', schema: { type: 'string', format: 'uuid' } },
        { name: 'userId', schema: { type: 'string', format: 'uuid' } },
      ],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid file ID, recipient ID, or workspace selection.' })
  @ApiForbiddenResponse({ description: 'Missing file write access in the selected workspace.' })
  @ApiNotFoundResponse({ description: 'Owned ready file not found in the selected workspace.' })
  @WorkspaceAccess('artifact.write')
  @Header('Cache-Control', 'private, no-store')
  @Delete(':id/shares/:userId')
  removeShare(
    @Param() { id }: IdQueryParamDto,
    @Param('userId', ParseUUIDPipe) recipientId: string,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
  ): Promise<DefaultMessageResponseDto> {
    return this.shares.removeShare(workspaceId, user.id, id, recipientId);
  }

  @Doc({
    summary: 'Update the stored access mode of a workspace file',
    description: 'Updates the access-mode selection for a ready file owned by the caller in the selected workspace.',
    response: { serialization: ArtifactListItemDto },
    request: {
      getWorkspaceId: true,
      params: [{ name: 'id', schema: { type: 'string', format: 'uuid' } }],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid access mode, file ID, or workspace selection.' })
  @ApiForbiddenResponse({ description: 'Missing file write access in the selected workspace.' })
  @ApiNotFoundResponse({ description: 'Owned ready file not found in the selected workspace.' })
  @WorkspaceAccess('artifact.write')
  @Header('Cache-Control', 'private, no-store')
  @Patch(':id')
  updateAccess(
    @Param() { id }: IdQueryParamDto,
    @Body() { shareType }: UpdateArtifactAccessDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
  ): Promise<ArtifactListItemDto> {
    return this.shares.updateAccess(workspaceId, user.id, id, shareType);
  }

  @Doc({
    summary: 'Delete a workspace file',
    description: 'Hides a ready file immediately and releases its quota after storage cleanup. Requires file read access and either ownership with artifact.write or artifact.manage.',
    response: { serialization: DefaultMessageResponseDto },
    request: {
      getWorkspaceId: true,
      params: [{ name: 'id', schema: { type: 'string', format: 'uuid' } }],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid file ID or workspace selection.' })
  @ApiForbiddenResponse({ description: 'Missing workspace file permissions.' })
  @ApiNotFoundResponse({ description: 'File not found in the selected workspace.' })
  @WorkspaceAccess('artifact.read')
  @Delete(':id')
  remove(
    @Param() { id }: IdQueryParamDto,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: UserContextPayload,
    @Req() request: RequestWithMetadata,
  ): Promise<DefaultMessageResponseDto> {
    return this.cleanup.remove({ workspaceId, artifactId: id }, user.id, request.permissions ?? []);
  }
}
