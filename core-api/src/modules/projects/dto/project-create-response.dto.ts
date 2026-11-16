import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectViewDto } from './project-view.dto';

export class ProjectInitialRunDto {
  @ApiProperty({ enum: ['started', 'empty_scope', 'failed'] })
  status: 'started' | 'empty_scope' | 'failed';

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  jobHistoryId?: string;
}

export class ProjectCreationOutcomeDto {
  @ApiPropertyOptional({ type: ProjectInitialRunDto })
  initialRun?: ProjectInitialRunDto;

  @ApiPropertyOptional({ enum: ['complete', 'pending'] })
  triggerSync?: 'complete' | 'pending';
}

/** Legacy create receipts omit the optional enriched-creation outcome. */
export class ProjectCreatedDto extends ProjectViewDto {
  @ApiPropertyOptional({ type: ProjectCreationOutcomeDto })
  creation?: ProjectCreationOutcomeDto;
}
