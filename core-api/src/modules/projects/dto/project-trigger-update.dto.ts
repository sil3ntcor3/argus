import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsString, ValidateIf } from 'class-validator';
import { ProjectTriggerConfigDto } from './project-trigger-read.dto';

export class UpdateProjectTriggerDto {
  @ApiPropertyOptional({
    description: 'Five-field UTC cron expression; cron triggers only',
  })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsString()
  cron?: string;
  @ApiPropertyOptional({
    type: ProjectTriggerConfigDto,
    description: 'Merge into existing event settings',
  })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsObject()
  config?: ProjectTriggerConfigDto;
  @ApiPropertyOptional()
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;
}
