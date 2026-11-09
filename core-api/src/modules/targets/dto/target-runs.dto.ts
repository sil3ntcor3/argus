import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { JobRunType, JobStatus } from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { parseBooleanQuery } from './parse-boolean-query';

export class GetTargetRunsQueryDto extends PickType(GetManyBaseQueryParams, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  declare page: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 10,
  })
  declare limit: number;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only unfinished runs from the last seven days that are pending or in progress',
  })
  @IsOptional()
  @Transform(parseBooleanQuery)
  @IsBoolean()
  active?: boolean;
}

export class TargetRunDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({
    enum: JobStatus,
    enumName: 'JobStatus',
    description: 'Status of the entire run',
  })
  status: JobStatus;

  @ApiProperty({ enum: JobRunType, enumName: 'JobRunType' })
  jobRunType: JobRunType;

  @ApiProperty()
  workflowName: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Linked workspace project, or null without project read access or a link',
  })
  projectId: string | null;

  @ApiProperty({ type: String, nullable: true })
  projectName: string | null;

  @ApiProperty({ minimum: 0, description: 'Jobs on the target' })
  jobsTotal: number;

  @ApiProperty({
    minimum: 0,
    description: 'Completed or skipped jobs on the target',
  })
  jobsDone: number;

  @ApiProperty({ minimum: 0, description: 'Failed jobs on the target' })
  jobsFailed: number;

  @ApiProperty({ minimum: 0, description: 'Running jobs on the target' })
  jobsRunning: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Tool on the running target job with the latest claim time. Missing times sort last, and ties use job ID descending.',
  })
  currentTool: string | null;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    nullable: true,
    description:
      'Findings first attributed to this run on the target, including later archives and dismissals. Null without vulnerability read access.',
  })
  newVulnerabilities: number | null;
}
