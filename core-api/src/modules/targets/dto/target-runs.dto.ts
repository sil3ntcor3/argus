import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { JobRunType, JobStatus } from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';

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
}
