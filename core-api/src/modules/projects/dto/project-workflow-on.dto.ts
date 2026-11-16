import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  ProjectTriggerConfigDto,
  PROJECT_TRIGGER_EVENTS,
} from './project-trigger-read.dto';
import type {
  WorkflowOnInput,
  EventTriggerInput,
} from '../project-workflow-on-input';

class ScheduleTriggerInputDto {
  @ApiProperty({ description: 'Five-field UTC cron expression' }) cron: string;
  @ApiPropertyOptional() enabled?: boolean;
}
class EventTriggerInputDto
  extends ProjectTriggerConfigDto
  implements EventTriggerInput
{
  @ApiProperty({
    enum: PROJECT_TRIGGER_EVENTS,
    enumName: 'ProjectTriggerEvent',
  })
  event: EventTriggerInput['event'];
  @ApiPropertyOptional() enabled?: boolean;
}
export class ProjectWorkflowOnDto implements WorkflowOnInput {
  @ApiPropertyOptional({ type: [ScheduleTriggerInputDto], maxItems: 20 })
  schedule?: ScheduleTriggerInputDto[];
  @ApiPropertyOptional({ type: [EventTriggerInputDto], maxItems: 3 })
  events?: EventTriggerInputDto[];
}
