import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactStagingSweepService } from './artifact-staging-sweep.service';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactsController } from './artifacts.controller';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceStorageUsage, WorkspaceArtifact])],
  controllers: [ArtifactsController],
  providers: [ArtifactUsageService, ArtifactStagingSweepService],
})
export class ArtifactsModule {}
