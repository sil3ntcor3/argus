import { ApiProperty, PickType } from '@nestjs/swagger';
import { SeverityCountsDto } from './project-assets-read.dto';
import { ProjectTriggerDto } from './project-trigger-read.dto';
import { ProjectViewDto } from './project-view.dto';

export class ProjectTriggerSummaryDto extends PickType(ProjectTriggerDto, [
  'id', 'projectWorkflowId', 'type', 'cron', 'event', 'enabled',
] as const) {}

/** List-only additions; detail and mutation receipts retain ProjectViewDto. */
export class ProjectListItemDto extends ProjectViewDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) workflowCount: number;
  @ApiProperty({ type: SeverityCountsDto, nullable: true, description: 'Open approved findings; null without vulnerability read access' })
  openVulnerabilities: SeverityCountsDto | null;
  @ApiProperty({ type: 'integer', minimum: 0, nullable: true, description: 'Open findings first attributed to the project in the last seven days; null without vulnerability read access' })
  newVulnerabilities: number | null;
  @ApiProperty({ type: [ProjectTriggerSummaryDto] }) triggers: ProjectTriggerSummaryDto[];
}
