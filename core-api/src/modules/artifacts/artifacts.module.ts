import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactExpiredUploadService } from './artifact-expired-upload.service';
import { ArtifactExpirySweepService } from './artifact-expiry-sweep.service';
import { ArtifactListService } from './artifact-list.service';
import { ArtifactQuotaService } from './artifact-quota.service';
import { ArtifactStagingSweepService } from './artifact-staging-sweep.service';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactsController } from './artifacts.controller';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceStorageUsage, WorkspaceArtifact])],
  controllers: [ArtifactsController],
  providers: [
    ArtifactUsageService,
    ArtifactListService,
    ArtifactQuotaService,
    ArtifactExpiredUploadService,
    ArtifactExpirySweepService,
    ArtifactStagingSweepService,
  ],
})
export class ArtifactsModule {}
