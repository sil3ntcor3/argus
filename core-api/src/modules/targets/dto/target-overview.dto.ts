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

export enum TargetInsightKind {
  STALE_SCAN = 'stale_scan',
  NEW_ASSETS = 'new_assets',
  NO_SCHEDULE = 'no_schedule',
}

export enum TargetInsightLevel {
  WARNING = 'warning',
  INFO = 'info',
}

class TargetInsightDto {
  @ApiProperty({ enum: TargetInsightKind, enumName: 'TargetInsightKind' })
  kind: TargetInsightKind;

  @ApiProperty({ enum: TargetInsightLevel, enumName: 'TargetInsightLevel' })
  level: TargetInsightLevel;

  @ApiProperty({ required: false, minimum: 1 })
  count?: number;

  @ApiProperty({ required: false, minimum: 1 })
  days?: number;
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

  @ApiProperty({
    type: [TargetInsightDto],
    description: 'Discovery and schedule insights for the target',
  })
  insights: TargetInsightDto[];
}
