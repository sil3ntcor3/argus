import { SeverityCountsDto } from '@/modules/projects/dto/project-assets-read.dto';
import { ApiProperty } from '@nestjs/swagger';
import { TargetRunDto } from './target-runs.dto';

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
  CRITICAL_OPEN = 'critical_open',
  LAST_RUN_FAILED = 'last_run_failed',
  TLS_EXPIRING = 'tls_expiring',
  STALE_SCAN = 'stale_scan',
  NEW_ASSETS = 'new_assets',
  NO_SCHEDULE = 'no_schedule',
}

export enum TargetInsightLevel {
  CRITICAL = 'critical',
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

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  runId?: string;
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
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Next recorded discovery firing time, or null when unavailable',
  })
  nextScanAt: Date | null;

  @ApiProperty({
    type: () => TargetRunDto,
    nullable: true,
    description: 'Latest target run, or null without job read access or a run',
  })
  lastRun: TargetRunDto | null;

  @ApiProperty({
    type: () => SeverityCountsDto,
    nullable: true,
    description: 'Open findings by severity, or null without vulnerability read access',
  })
  openVulnerabilities: SeverityCountsDto | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Open findings first seen in the last seven days, or null without vulnerability read access',
  })
  newVulnerabilities: number | null;

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
