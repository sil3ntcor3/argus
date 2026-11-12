import { Module } from '@nestjs/common';
import { ProjectTriggerReadService } from './project-trigger-read.service';
import { ProjectTriggerCreateService } from './project-trigger-create.service';
import { ProjectTriggerDefinitionService } from './project-trigger-definition.service';
import { AssetGroupModule } from '../asset-group/asset-group.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ProjectWorkflowJobsService } from './project-workflow-jobs.service';
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
import { ProjectWorkflowUpdateService } from './project-workflow-update.service';
import { ProjectWorkflowCreateService } from './project-workflow-create.service';
import { ProjectWorkflowTemplatesService } from './project-workflow-templates.service';
import { ProjectRunReadService } from './project-run-read.service';
import { ProjectFindingReadService } from './project-finding-read.service';
import { ProjectFindingTimelineService } from './project-finding-timeline.service';
import { ProjectOverviewCountsService } from './project-overview-counts.service';
import { ProjectOverviewRunsService } from './project-overview-runs.service';
import { ProjectOverviewActivityService } from './project-overview-activity.service';
import { ProjectOverviewReadService } from './project-overview-read.service';

@Module({
  imports: [AssetGroupModule, ProjectScopeModule, ConnectorsModule],
  controllers: [ProjectsController],
  providers: [
    ProjectTriggerReadService,
    ProjectTriggerCreateService,
    ProjectTriggerDefinitionService,
    ProjectOverviewReadService,
    ProjectOverviewActivityService,
    ProjectOverviewRunsService,
    ProjectOverviewCountsService,
    ProjectFindingTimelineService,
    ProjectFindingReadService,
    ProjectRunReadService,
    ProjectWorkflowTemplatesService,
    ProjectWorkflowCreateService,
    ProjectWorkflowUpdateService,
    ProjectWorkflowJobsService,
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
