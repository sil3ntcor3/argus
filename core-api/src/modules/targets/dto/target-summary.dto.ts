import { SeverityCountsDto } from '@/modules/projects/dto/project-assets-read.dto';
import { ApiProperty } from '@nestjs/swagger';

export class TargetSummaryDto {
  @ApiProperty({ minimum: 0 })
  total: number;

  @ApiProperty({
    minimum: 0,
    description: 'Targets with a pending or running job',
  })
  scanning: number;

  @ApiProperty({ minimum: 0, description: 'Targets with discovery scheduled' })
  scheduled: number;

  @ApiProperty({
    minimum: 0,
    description: 'Targets with no discovery in 30 days',
  })
  stale: number;

  @ApiProperty({
    type: Number,
    minimum: 0,
    nullable: true,
    description:
      'Targets with an open critical finding, or null without vulnerability read access',
  })
  withCritical: number | null;

  @ApiProperty({
    type: () => SeverityCountsDto,
    nullable: true,
    description:
      'Open findings by severity, or null without vulnerability read access',
  })
  openVulnerabilities: SeverityCountsDto | null;
}
