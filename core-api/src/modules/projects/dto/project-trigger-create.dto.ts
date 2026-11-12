import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsString, IsUUID, ValidateIf } from 'class-validator';
import {
  PROJECT_TRIGGER_EVENTS,
  ProjectTriggerConfigDto,
  type ProjectTriggerDto,
} from './project-trigger-read.dto';

export class CreateProjectTriggerDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectWorkflowId: string;

  @ApiProperty({ enum: ['cron', 'event'], enumName: 'ProjectTriggerType' })
  @IsIn(['cron', 'event'])
  type: 'cron' | 'event';

  @ApiPropertyOptional({ description: 'Five-field UTC cron expression' })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsString()
  cron?: string;

  @ApiPropertyOptional({
    enum: PROJECT_TRIGGER_EVENTS,
    enumName: 'ProjectTriggerEvent',
  })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsIn(PROJECT_TRIGGER_EVENTS)
  event?: NonNullable<ProjectTriggerDto['event']>;

  @ApiPropertyOptional({ type: ProjectTriggerConfigDto })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsObject()
  config?: ProjectTriggerConfigDto;
}
