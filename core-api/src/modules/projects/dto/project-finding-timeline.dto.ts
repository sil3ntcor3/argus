import { ApiProperty } from '@nestjs/swagger';
import { ProjectTimelineSighting } from '../project-finding-timeline.service';
import { ProjectFindingDto } from './project-findings.dto';

export class ProjectFindingTimelineRunDto {
  @ApiProperty({ type: String, format: 'uuid' }) id: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty() workflowName: string;
  @ApiProperty({ enum: ProjectTimelineSighting })
  sighting: ProjectTimelineSighting;
}

export class ProjectFindingTimelineDto {
  @ApiProperty({ type: () => ProjectFindingDto })
  vulnerability: ProjectFindingDto;

  @ApiProperty({ type: () => ProjectFindingTimelineRunDto, isArray: true })
  runs: ProjectFindingTimelineRunDto[];
}
