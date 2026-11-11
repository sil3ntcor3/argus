import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactCleanupService } from './artifact-cleanup.service';
import { ArtifactExpirySweepService } from './artifact-expiry-sweep.service';
import { ArtifactFoldersController } from './artifact-folders.controller';
import { ArtifactFoldersService } from './artifact-folders.service';
import { ArtifactQuotaService } from './artifact-quota.service';
import { ArtifactReadService } from './artifact-read.service';
import { ArtifactShareService } from './artifact-share.service';
import { ArtifactStagingSweepService } from './artifact-staging-sweep.service';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactFolder } from './entities/artifact-folder.entity';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceStorageUsage, WorkspaceArtifact, ArtifactFolder])],
  controllers: [ArtifactsController, ArtifactFoldersController],
  providers: [
    ArtifactUsageService,
    ArtifactReadService,
    ArtifactShareService,
    ArtifactQuotaService,
    ArtifactCleanupService,
    ArtifactExpirySweepService,
    ArtifactFoldersService,
    ArtifactStagingSweepService,
  ],
})
export class ArtifactsModule {}
