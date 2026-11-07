import {
  DismissReason,
  JobRunType,
  JobStatus,
  ProjectChange,
} from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PROJECT_ACTIVITY_LIMIT } from '../project-overview-activity.service';
import { SeverityCountsDto } from './project-assets-read.dto';

const runRefProperties = {
  id: { type: 'string', format: 'uuid' },
  createdAt: { type: 'string', format: 'date-time' },
  workflowName: { type: 'string' },
  jobRunType: { type: 'string', enum: Object.values(JobRunType) },
  status: { type: 'string', enum: Object.values(JobStatus) },
} as const;

export class ProjectOverviewRunRefDto {
  @ApiProperty(runRefProperties.id) id: string;
  @ApiProperty(runRefProperties.createdAt) createdAt: Date;
  @ApiProperty(runRefProperties.workflowName) workflowName: string;
  @ApiProperty(runRefProperties.jobRunType) jobRunType: JobRunType;
  @ApiProperty(runRefProperties.status) status: JobStatus;
}

export class ProjectOverviewWeekDto extends SeverityCountsDto {
  @ApiProperty({ type: String, format: 'date', description: 'Monday in UTC' })
  week: string;
}

export class ProjectOverviewActivityDto {
  @ApiProperty({ enum: ['run', 'audit', 'dismissed'] })
  kind: 'run' | 'audit' | 'dismissed';

  @ApiProperty({ description: 'Run ID, audit action or dismissal' })
  ref: string;
  @ApiProperty({ type: String, format: 'date-time' }) at: Date;
  @ApiPropertyOptional() actorName?: string;
  @ApiPropertyOptional({ enum: ProjectChange }) change?: ProjectChange;
  @ApiPropertyOptional() workflowName?: string;
  @ApiPropertyOptional({ enum: JobRunType }) jobRunType?: JobRunType;
  @ApiPropertyOptional({ enum: JobStatus }) runStatus?: JobStatus;
  @ApiPropertyOptional({ enum: DismissReason }) reason?: DismissReason;
  @ApiPropertyOptional({ type: 'integer', minimum: 0 }) added?: number;
  @ApiPropertyOptional({ type: 'integer', minimum: 0 }) removed?: number;
  @ApiPropertyOptional({ type: 'integer', minimum: 1 }) count?: number;
  @ApiPropertyOptional({ type: 'integer', minimum: 0 }) scopeSize?: number;
  @ApiPropertyOptional({ type: 'integer', minimum: 0 })
  newVulnerabilities?: number;
  @ApiPropertyOptional({ type: 'integer', minimum: 0 })
  recurringVulnerabilities?: number;
}

export class ProjectOverviewDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) totalAssets: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) newAssets: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) workflows: number;
  @ApiProperty({ type: () => SeverityCountsDto })
  openVulnerabilities: SeverityCountsDto;
  @ApiProperty({ type: 'integer', minimum: 0 }) newVulnerabilities: number;

  @ApiProperty({
    type: () => ProjectOverviewRunRefDto,
    isArray: true,
    maxItems: 5,
  })
  newVulnerabilityRuns: ProjectOverviewRunRefDto[];

  @ApiProperty({
    // Keep null and the required object fields in one OpenAPI 3.0 schema.
    oneOf: [
      {
        type: 'object',
        nullable: true,
        properties: runRefProperties,
        required: Object.keys(runRefProperties),
      },
    ],
  })
  lastRun: ProjectOverviewRunRefDto | null;

  @ApiProperty({
    type: () => ProjectOverviewWeekDto,
    isArray: true,
    minItems: 8,
    maxItems: 8,
  })
  weekly: ProjectOverviewWeekDto[];

  @ApiProperty({
    type: () => ProjectOverviewActivityDto,
    isArray: true,
    maxItems: PROJECT_ACTIVITY_LIMIT,
  })
  activity: ProjectOverviewActivityDto[];
}
