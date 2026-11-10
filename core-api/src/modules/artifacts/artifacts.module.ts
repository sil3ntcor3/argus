import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactsController } from './artifacts.controller';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceStorageUsage])],
  controllers: [ArtifactsController],
  providers: [ArtifactUsageService],
})
export class ArtifactsModule {}
