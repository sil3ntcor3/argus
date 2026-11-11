import { CronSchedule } from '@/common/enums/enum';
import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { WorkflowJob } from '@/modules/workflows/entities/workflow.entity';
import {
  IsObject,
  IsString,
  Matches,
  MaxLength,
  NotContains,
  ValidateIf,
} from 'class-validator';

export class CreateProjectWorkflowDto {
  @ApiPropertyOptional({
    description:
      'Workspace template path. Supply exactly one of template or jobs.',
    maxLength: 255,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @NotContains('\u0000')
  @MaxLength(255)
  template?: string;

  @ApiPropertyOptional({
    description: 'Selected job graph. Supply exactly one of template or jobs.',
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(WorkflowJob) },
    minProperties: 1,
    maxProperties: 50,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
  jobs?: Record<string, WorkflowJob>;

  @ApiPropertyOptional({
    description:
      'Defaults to the template name or Project workflow for selected jobs',
    maxLength: 120,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @NotContains('\u0000')
  @MaxLength(120)
  name?: string;
}

export class CreatedProjectWorkflowDto {
  @ApiProperty({ format: 'uuid', description: 'Project workflow binding ID' })
  id: string;

  @ApiProperty({ format: 'uuid', description: 'Project-owned workflow ID' })
  workflowId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: [CronSchedule.DISABLED] })
  schedule: CronSchedule.DISABLED;
}
