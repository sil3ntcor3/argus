import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { JobRunType, JobStatus } from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export class GetProjectRunsQueryDto extends PickType(GetManyBaseQueryParams, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  declare page: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 10 })
  declare limit: number;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectWorkflowId?: string;

  @ApiPropertyOptional({ enum: JobRunType })
  @IsOptional()
  @IsEnum(JobRunType)
  jobRunType?: JobRunType;
}

export class ProjectRunDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({ type: Boolean })
  isCompleted: boolean;

  @ApiProperty({ enum: JobRunType })
  jobRunType: JobRunType;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  projectWorkflowId: string | null;

  @ApiProperty()
  workflowName: string;

  @ApiProperty({ enum: JobStatus, enumName: 'JobStatus' })
  status: JobStatus;

  @ApiProperty({ type: Number, minimum: 0 })
  scopeSize: number;

  @ApiProperty({ type: Number, minimum: 0 })
  stepsTotal: number;

  @ApiProperty({ type: Number, minimum: 0 })
  stepsDone: number;

  @ApiProperty({ type: Number, minimum: 0 })
  stepsFailed: number;

  @ApiProperty({ type: Number, minimum: 0 })
  newVulnerabilities: number;

  @ApiProperty({ type: Number, minimum: 0 })
  recurringVulnerabilities: number;
}
