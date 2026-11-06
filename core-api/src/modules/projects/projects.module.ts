import { Module } from '@nestjs/common';
import { AssetGroupModule } from '../asset-group/asset-group.module';
import { ProjectsController } from './projects.controller';
import { ProjectMetadataReadService } from './project-metadata-read.service';

@Module({
  imports: [AssetGroupModule],
  controllers: [ProjectsController],
  providers: [ProjectMetadataReadService],
})
export class ProjectsModule {}
