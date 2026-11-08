import { CronSchedule } from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MaxLength,
  NotContains,
  ValidateIf,
} from 'class-validator';

export class CreateProjectWorkflowDto {
  @ApiProperty({
    description: 'File path from the workspace template catalog',
    maxLength: 255,
  })
  @IsString()
  @Matches(/\S/)
  @NotContains('\u0000')
  @MaxLength(255)
  template: string;

  @ApiPropertyOptional({
    description: 'Defaults to the template name',
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
