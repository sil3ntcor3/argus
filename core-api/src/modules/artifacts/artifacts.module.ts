import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactCleanupService } from './artifact-cleanup.service';
import { ArtifactExpirySweepService } from './artifact-expiry-sweep.service';
import { ArtifactFoldersController } from './artifact-folders.controller';
import { ArtifactFoldersService } from './artifact-folders.service';
import { ArtifactQuotaModule } from './artifact-quota.module';
import { ArtifactReadService } from './artifact-read.service';
import { ArtifactShareService } from './artifact-share.service';
import { ArtifactStagingSweepService } from './artifact-staging-sweep.service';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactWriteModule } from './artifact-write.module';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactFolder } from './entities/artifact-folder.entity';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';
import { PublicArtifactsController } from './public-artifacts.controller';

@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceStorageUsage, WorkspaceArtifact, ArtifactFolder]), ArtifactQuotaModule, ArtifactWriteModule],
  controllers: [ArtifactsController, ArtifactFoldersController, PublicArtifactsController],
  providers: [
    ArtifactUsageService,
    ArtifactReadService,
    ArtifactShareService,
    ArtifactCleanupService,
    ArtifactExpirySweepService,
    ArtifactFoldersService,
    ArtifactStagingSweepService,
  ],
})
export class ArtifactsModule {}
