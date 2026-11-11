import { ARTIFACT_BUCKET } from '@/common/constants/artifact-storage';
import { SortOrder, type GetManyBaseResponseDto } from '@/common/dtos/get-many-base.dto';
import { StorageService } from '@/modules/storage/storage.service';
import { getManyResponse } from '@/utils/getManyResponse';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ArtifactFoldersService } from './artifact-folders.service';
import type { ArtifactDownloadDto } from './dto/artifact-download.dto';
import { ARTIFACT_ROOT_FOLDER, ARTIFACT_SORT_FIELDS, ArtifactListScope, type ArtifactListCreatorDto, type ArtifactListItemDto, type ArtifactListQueryDto } from './dto/artifact-list.dto';
import { ArtifactShare } from './entities/artifact-share.entity';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

const DOWNLOAD_TTL_SECONDS = 5 * 60;
const OWNED_OR_SHARED_FILE = `(
  artifact."createdByUserId" = :userId OR (
    artifact."shareType" = 'shared' AND EXISTS (
      SELECT 1 FROM artifact_shares recipient_share
      JOIN workspace_members recipient_member
        ON recipient_member."workspaceId" = artifact."workspaceId"
        AND recipient_member."userId" = recipient_share."userId"
      WHERE recipient_share."artifactId" = artifact.id
        AND recipient_share."userId" = :userId
    )
  )
)`;

@Injectable()
export class ArtifactReadService {
  constructor(
    @InjectRepository(WorkspaceArtifact)
    private readonly artifacts: Repository<WorkspaceArtifact>,
    private readonly storage: StorageService,
    private readonly folders: ArtifactFoldersService,
  ) {}

  async getMany(
    workspaceId: string,
    userId: string,
    query: ArtifactListQueryDto,
    permissions: string[],
  ): Promise<GetManyBaseResponseDto<ArtifactListItemDto>> {
    const all = query.scope === ArtifactListScope.ALL;
    const shared = query.scope === ArtifactListScope.SHARED;
    if (all && !this.canManage(permissions)) {
      throw new ForbiddenException('Requires artifact.manage');
    }
    const parentFolderId = query.parentFolderId;
    if (query.scope !== ArtifactListScope.MINE && parentFolderId !== undefined) {
      throw new BadRequestException('Folder filtering requires mine scope');
    }

    const builder = this.readyFiles(workspaceId);
    if (shared) {
      builder.andWhere('artifact.createdByUserId IS DISTINCT FROM :userId', { userId })
        .andWhere(OWNED_OR_SHARED_FILE, { userId });
    } else if (!all) {
      builder.andWhere('artifact.createdByUserId = :userId', { userId });
    }
    if (parentFolderId === ARTIFACT_ROOT_FOLDER) {
      builder.andWhere('artifact.parentFolderId IS NULL');
    } else if (parentFolderId !== undefined) {
      await this.folders.getById(workspaceId, userId, parentFolderId);
      builder.andWhere('artifact.parentFolderId = :parentFolderId', { parentFolderId });
    }
    const search = query.search.trim();
    if (search) {
      const literal = search.replace(/[\\%_]/g, '\\$&');
      builder.andWhere('artifact.name ILIKE :search', { search: `%${literal}%` });
    }

    const sortBy = ARTIFACT_SORT_FIELDS.includes(query.sortBy) ? query.sortBy : 'createdAt';
    const order = query.sortOrder ?? SortOrder.ASC;
    const [rows, total] = await builder
      .orderBy(`artifact.${sortBy}`, order)
      .addOrderBy('artifact.id', order)
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    const data = rows.map(row => this.toMetadata(row, userId));
    return getManyResponse({ query, data, total });
  }

  async getById(
    workspaceId: string,
    userId: string,
    id: string,
    permissions: string[],
  ): Promise<ArtifactListItemDto> {
    const builder = this.readyFiles(workspaceId).andWhere('artifact.id = :id', { id });
    if (!this.canManage(permissions)) {
      builder.andWhere(OWNED_OR_SHARED_FILE, { userId });
    }
    const row = await builder.getOne();
    if (!row) throw new NotFoundException('File not found');
    return this.toMetadata(row, userId);
  }

  async getDownloadUrl(workspaceId: string, userId: string, id: string): Promise<ArtifactDownloadDto> {
    // Workspace management grants metadata access only.
    const file = await this.readyArtifacts(workspaceId)
      .andWhere('artifact.id = :id', { id })
      .andWhere(OWNED_OR_SHARED_FILE, { userId })
      .select(['artifact.id', 'artifact.name', 'artifact.objectKey'])
      .getOne();
    if (!file) throw new NotFoundException('File not found');

    return this.storage.getPresignedDownloadUrl({
      bucket: ARTIFACT_BUCKET,
      key: file.objectKey,
      fileName: file.name || 'file',
      // The storage proxy can share the console's origin. Serve bytes as an attachment.
      contentType: 'application/octet-stream',
      expiresIn: DOWNLOAD_TTL_SECONDS,
    });
  }

  async getShares(workspaceId: string, userId: string, id: string): Promise<ArtifactListCreatorDto[]> {
    // Keep the owned file in the result even when it has no current recipients.
    const rows = await this.readyArtifacts(workspaceId)
      .andWhere('artifact.id = :id AND artifact.createdByUserId = :userId', { id, userId })
      .leftJoin(ArtifactShare, 'share', `share."artifactId" = artifact.id AND EXISTS (
        SELECT 1 FROM workspace_members member
        WHERE member."workspaceId" = artifact."workspaceId" AND member."userId" = share."userId"
      )`)
      .leftJoin('share.user', 'recipient')
      .select('recipient.id', 'id')
      .addSelect('recipient.name', 'name')
      .addSelect('recipient.image', 'image')
      .orderBy('share.createdAt', 'ASC')
      .addOrderBy('share.id', 'ASC')
      .getRawMany<ArtifactListCreatorDto | { id: null; name: null; image: null }>();

    if (!rows.length) throw new NotFoundException('File not found');
    return rows.filter((row): row is ArtifactListCreatorDto => row.id !== null);
  }

  private readyArtifacts(workspaceId: string) {
    return this.artifacts.createQueryBuilder('artifact')
      .where('artifact.workspaceId = :workspaceId', { workspaceId })
      .andWhere('artifact.status = :status', { status: 'ready' });
  }

  private readyFiles(workspaceId: string) {
    return this.readyArtifacts(workspaceId)
      .leftJoin('artifact.createdBy', 'creator')
      .select([
        'artifact.id', 'artifact.name', 'artifact.mimeType', 'artifact.sizeBytes', 'artifact.source',
        'artifact.createdByUserId', 'artifact.createdAt', 'artifact.updatedAt', 'artifact.shareType',
        'creator.id', 'creator.name', 'creator.image',
      ]);
  }

  private canManage(permissions: string[]): boolean {
    return permissions.includes('artifact.manage') || permissions.includes('*');
  }

  private toMetadata(row: WorkspaceArtifact, userId: string): ArtifactListItemDto {
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      source: row.source,
      shareType: row.shareType,
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name, image: row.createdBy.image ?? null } : null,
      isOwner: row.createdByUserId === userId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
