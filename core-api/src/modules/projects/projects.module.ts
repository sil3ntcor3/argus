import { Module } from '@nestjs/common';
import { AssetGroupModule } from '../asset-group/asset-group.module';
import { ProjectsController } from './projects.controller';
import { ProjectMetadataReadService } from './project-metadata-read.service';
import { ProjectScopeNormalizer } from './project-scope-normalizer.service';
import { ProjectScopePreviewService } from './project-scope-preview.service';
import { ProjectScopeReadService } from './project-scope-read.service';
import { ProjectScopeWriteService } from './project-scope-write.service';
import { ProjectScopeModule } from './project-scope.module';
import { ProjectAssetsService } from './project-assets.service';
import { ProjectAssetsCommandService } from './project-assets-command.service';
import { ProjectAssetReadService } from './project-asset-read.service';
import { ProjectWorkflowTemplatesService } from './project-workflow-templates.service';
import { ProjectRunReadService } from './project-run-read.service';
import { ProjectFindingReadService } from './project-finding-read.service';
import { ProjectFindingTimelineService } from './project-finding-timeline.service';

@Module({
  imports: [AssetGroupModule, ProjectScopeModule],
  controllers: [ProjectsController],
  providers: [
    ProjectFindingTimelineService,
    ProjectFindingReadService,
    ProjectRunReadService,
    ProjectWorkflowTemplatesService,
    ProjectAssetReadService,
    ProjectAssetsService,
    ProjectAssetsCommandService,
    ProjectMetadataReadService,
    ProjectScopeNormalizer,
    ProjectScopePreviewService,
    ProjectScopeReadService,
    ProjectScopeWriteService,
  ],
})
export class ProjectsModule {}
