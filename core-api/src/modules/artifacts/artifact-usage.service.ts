import { ARTIFACT_MAX_FILE_BYTES } from '@/common/constants/artifact-storage';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ARTIFACT_WORKSPACE_QUOTA_BYTES } from './artifact-quota.service';
import type { ArtifactUsageDto } from './dto/artifact-usage.dto';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

@Injectable()
export class ArtifactUsageService {
  constructor(
    @InjectRepository(WorkspaceStorageUsage)
    private readonly usage: Repository<WorkspaceStorageUsage>,
  ) {}

  async getUsage(workspaceId: string): Promise<ArtifactUsageDto> {
    const meter = await this.usage.findOneBy({ workspaceId });
    // Schema constraints keep stored bigint strings in the safe integer range.
    return {
      quotaBytes: Number(meter?.quotaBytes ?? ARTIFACT_WORKSPACE_QUOTA_BYTES),
      usedBytes: Number(meter?.usedBytes ?? 0),
      reservedBytes: Number(meter?.reservedBytes ?? 0),
      maxFileBytes: ARTIFACT_MAX_FILE_BYTES,
    };
  }
}
