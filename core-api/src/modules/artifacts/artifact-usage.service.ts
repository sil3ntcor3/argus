import { ARTIFACT_MAX_FILE_BYTES } from '@/common/constants/artifact-storage';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ARTIFACT_WORKSPACE_QUOTA_BYTES } from './artifact-quota.service';
import type { ArtifactUsageDto } from './dto/artifact-usage.dto';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

@Injectable()
export class ArtifactUsageService {
  constructor(
    @InjectRepository(WorkspaceStorageUsage)
    private readonly usage: Repository<WorkspaceStorageUsage>,
    @InjectRepository(WorkspaceArtifact)
    private readonly artifacts: Repository<WorkspaceArtifact>,
  ) {}

  async getUsage(workspaceId: string): Promise<ArtifactUsageDto> {
    const ready = () => this.artifacts
      .createQueryBuilder('artifact')
      .select('SUM(artifact.sizeBytes)', 'bytes')
      .where('artifact.workspaceId = :workspaceId', { workspaceId })
      .andWhere('artifact.status = :status', { status: 'ready' });
    const [meter, bySource, byUser] = await Promise.all([
      this.usage.findOneBy({ workspaceId }),
      ready()
        .addSelect('artifact.source', 'source')
        .groupBy('artifact.source')
        .orderBy('bytes', 'DESC')
        .addOrderBy('artifact.source', 'ASC')
        .getRawMany<{ source: WorkspaceArtifact['source']; bytes: string }>(),
      ready()
        .leftJoin('artifact.createdBy', 'creator')
        .addSelect('creator.id', 'userId')
        .addSelect('creator.name', 'userName')
        .addSelect('creator.image', 'userImage')
        .groupBy('creator.id')
        .orderBy('bytes', 'DESC')
        .addOrderBy('creator.id', 'ASC', 'NULLS LAST')
        .getRawMany<{
          userId: string | null;
          userName: string | null;
          userImage: string | null;
          bytes: string;
        }>(),
    ]);
    // Schema constraints keep stored bigint strings in the safe integer range.
    return {
      quotaBytes: Number(meter?.quotaBytes ?? ARTIFACT_WORKSPACE_QUOTA_BYTES),
      usedBytes: Number(meter?.usedBytes ?? 0),
      reservedBytes: Number(meter?.reservedBytes ?? 0),
      maxFileBytes: ARTIFACT_MAX_FILE_BYTES,
      bySource: bySource.map(row => ({ source: row.source, bytes: Number(row.bytes) })),
      byUser: byUser.map(row => ({
        user: row.userId ? { id: row.userId, name: row.userName ?? '', image: row.userImage } : null,
        bytes: Number(row.bytes),
      })),
    };
  }
}
