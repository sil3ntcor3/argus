import { SortOrder, type GetManyBaseResponseDto } from '@/common/dtos/get-many-base.dto';
import { getManyResponse } from '@/utils/getManyResponse';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ARTIFACT_SORT_FIELDS, ArtifactListScope, type ArtifactListItemDto, type ArtifactListQueryDto } from './dto/artifact-list.dto';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

@Injectable()
export class ArtifactReadService {
  constructor(
    @InjectRepository(WorkspaceArtifact)
    private readonly artifacts: Repository<WorkspaceArtifact>,
  ) {}

  async getMany(
    workspaceId: string,
    userId: string,
    query: ArtifactListQueryDto,
    permissions: string[],
  ): Promise<GetManyBaseResponseDto<ArtifactListItemDto>> {
    const all = query.scope === ArtifactListScope.ALL;
    if (all && !this.canManage(permissions)) {
      throw new ForbiddenException('Requires artifact.manage');
    }

    const builder = this.readyFiles(workspaceId);
    if (!all) builder.andWhere('artifact.createdByUserId = :userId', { userId });
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
      builder.andWhere('artifact.createdByUserId = :userId', { userId });
    }
    const row = await builder.getOne();
    if (!row) throw new NotFoundException('File not found');
    return this.toMetadata(row, userId);
  }

  private readyFiles(workspaceId: string) {
    return this.artifacts.createQueryBuilder('artifact')
      .leftJoin('artifact.createdBy', 'creator')
      .select([
        'artifact.id', 'artifact.name', 'artifact.mimeType', 'artifact.sizeBytes', 'artifact.source',
        'artifact.createdByUserId', 'artifact.createdAt', 'artifact.updatedAt',
        'creator.id', 'creator.name', 'creator.image',
      ])
      .where('artifact.workspaceId = :workspaceId', { workspaceId })
      .andWhere('artifact.status = :status', { status: 'ready' });
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
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name, image: row.createdBy.image ?? null } : null,
      isOwner: row.createdByUserId === userId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
