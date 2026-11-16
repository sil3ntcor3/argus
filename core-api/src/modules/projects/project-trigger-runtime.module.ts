import { BullMQName } from '@/common/enums/enum';
import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { Job } from 'bullmq';
import { ProjectTriggerDefinitionService } from './project-trigger-definition.service';
import {
  ProjectTriggerBatchService,
  type ProjectTriggerEventJob,
} from './project-trigger-batch.service';
import { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';
import { ProjectRunEventsListener } from './project-run-events.listener';
import { ProjectLegacyScheduleService } from './project-legacy-schedule.service';

@Processor(BullMQName.PROJECT_TRIGGER_EVENTS)
class ProjectTriggerEventConsumer extends WorkerHost {
  constructor(private readonly triggers: ProjectTriggerRuntimeService) {
    super();
  }
  async process(job: Job<ProjectTriggerEventJob>): Promise<void> {
    await this.triggers.fireEvent(job.data);
  }
}

/** Shared by the event bridge, project commands and existing schedule consumer. */
@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE },
      { name: BullMQName.PROJECT_TRIGGER_EVENTS },
    ),
  ],
  providers: [
    ProjectLegacyScheduleService,
    ProjectTriggerDefinitionService,
    ProjectTriggerBatchService,
    ProjectTriggerRuntimeService,
    ProjectRunEventsListener,
    ProjectTriggerEventConsumer,
  ],
  exports: [
    ProjectLegacyScheduleService,
    ProjectTriggerDefinitionService,
    ProjectTriggerRuntimeService,
    ProjectTriggerBatchService,
  ],
})
export class ProjectTriggerRuntimeModule {}
