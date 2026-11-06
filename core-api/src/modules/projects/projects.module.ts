import { Module } from '@nestjs/common';
import { AssetGroupModule } from '../asset-group/asset-group.module';
import { ProjectsController } from './projects.controller';

@Module({
  imports: [AssetGroupModule],
  controllers: [ProjectsController],
})
export class ProjectsModule {}
