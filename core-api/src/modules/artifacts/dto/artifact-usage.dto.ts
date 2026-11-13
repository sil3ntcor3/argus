import { ApiProperty } from '@nestjs/swagger';
import { ArtifactListCreatorDto } from './artifact-list.dto';

export class ArtifactSourceUsageDto {
  @ApiProperty({ enum: ['upload', 'agent', 'template'] })
  source: 'upload' | 'agent' | 'template';

  @ApiProperty({ minimum: 0 })
  bytes: number;
}

export class ArtifactUserUsageDto {
  @ApiProperty({ type: ArtifactListCreatorDto, nullable: true })
  user: ArtifactListCreatorDto | null;

  @ApiProperty({ minimum: 0 })
  bytes: number;
}

export class ArtifactUsageDto {
  @ApiProperty({ minimum: 0, description: 'Effective workspace quota in bytes' })
  quotaBytes: number;

  @ApiProperty({ minimum: 0, description: 'Bytes used by ready files' })
  usedBytes: number;

  @ApiProperty({ minimum: 0, description: 'Bytes reserved for pending uploads' })
  reservedBytes: number;

  @ApiProperty({ minimum: 0, description: 'Maximum size of one file in bytes' })
  maxFileBytes: number;

  @ApiProperty({ type: [ArtifactSourceUsageDto], description: 'Ready-file bytes grouped by source, largest first.' })
  bySource: ArtifactSourceUsageDto[];

  @ApiProperty({ type: [ArtifactUserUsageDto], description: 'Ready-file bytes grouped by creator, largest first. Removed creators are grouped under null.' })
  byUser: ArtifactUserUsageDto[];
}
