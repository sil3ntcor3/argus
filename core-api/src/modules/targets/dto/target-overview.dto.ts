import { ApiProperty } from '@nestjs/swagger';

class TargetExposureCountDto {
  @ApiProperty()
  name: string;

  @ApiProperty({ minimum: 1, description: 'Distinct services in this group' })
  count: number;
}

class TargetExposureDto {
  @ApiProperty({ type: [TargetExposureCountDto], maxItems: 6 })
  ports: TargetExposureCountDto[];

  @ApiProperty({ type: [TargetExposureCountDto], maxItems: 6 })
  technologies: TargetExposureCountDto[];

  @ApiProperty({ type: [TargetExposureCountDto], maxItems: 6 })
  statusCodes: TargetExposureCountDto[];
}

export class TargetOverviewDto {
  @ApiProperty({ description: 'Enabled assets on the target' })
  totalAssets: number;

  @ApiProperty({
    description: 'Enabled assets discovered in the last seven days',
  })
  newAssets: number;

  @ApiProperty({ description: 'Discovered services on the target' })
  totalServices: number;

  @ApiProperty({ description: 'Services discovered in the last seven days' })
  newServices: number;

  @ApiProperty({ description: 'Distinct ports among discovered services' })
  openPorts: number;

  @ApiProperty({
    type: TargetExposureDto,
    description: 'Most common service observations',
  })
  exposure: TargetExposureDto;
}
