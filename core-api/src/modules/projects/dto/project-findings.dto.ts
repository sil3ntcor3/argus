import {
  GetManyBaseQueryParams,
  GetManyBaseResponseDto,
  SortOrder,
} from '@/common/dtos/get-many-base.dto';
import { Severity } from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  MaxLength,
  NotContains,
} from 'class-validator';
import { VulnerabilityStatus } from '../../vulnerabilities/dto/get-vulnerability.dto';
import { ProjectFindingProvenance } from '../project-finding-provenance';
import { SeverityCountsDto } from './project-assets-read.dto';
import { parseFilterParam } from '@/common/utils/filter-tree';
import { IsVulnerabilityFilter, type VulnerabilityFilter } from '../../vulnerabilities/vulnerability-filter';
import { DISCOVERY_SOURCES, REVIEW_STATUSES, type DiscoverySource, type ReviewStatus } from '../../vulnerabilities/dto/vulnerability-review.dto';
import { PUBLIC_DETECTION_STATUSES } from '../../vulnerabilities/dto/vulnerability-lifecycle.dto';
import { FINDING_DISMISS_REASONS, type FindingDismissalReason } from '../../vulnerabilities/finding-dismissal-reason';
import { GetVulnerabilitiesStatisticsResponseDto } from '../../vulnerabilities/dto/get-vulnerability-statistics.dto';

export const PROJECT_FINDING_SORTS = ['severity', 'name', 'firstDetectedDate', 'lastSeenDate', 'firstSeenAt', 'lastSeenAt', 'dueAt'] as const;

export class GetProjectFindingsQueryDto extends PickType(
  GetManyBaseQueryParams,
  ['page', 'limit', 'search'] as const,
) {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsInt()
  declare page: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 10,
  })
  @IsInt()
  declare limit: number;

  @ApiPropertyOptional({
    type: String,
    maxLength: 200,
    description: 'Literal search without NUL characters',
  })
  @MaxLength(200)
  @NotContains('\u0000', { message: 'search must not contain NUL characters' })
  declare search?: string;

  @ApiPropertyOptional({ enum: Severity, isArray: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? (value as unknown[]) : [value],
  )
  @IsArray()
  @IsEnum(Severity, { each: true })
  severity?: Severity[];

  @ApiPropertyOptional({ enum: ProjectFindingProvenance })
  @IsOptional()
  @IsEnum(ProjectFindingProvenance)
  provenance?: ProjectFindingProvenance;

  @ApiPropertyOptional({
    enum: VulnerabilityStatus,
    default: VulnerabilityStatus.OPEN,
    description: 'Open excludes archived, fixed and dismissed findings. Review statuses require vulnerability read access; all includes approved findings only.',
  })
  @IsOptional()
  @IsEnum(VulnerabilityStatus)
  status?: VulnerabilityStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Seen in this run',
  })
  @IsOptional()
  @IsUUID()
  jobHistoryId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Seen in a run of this project workflow',
  })
  @IsOptional()
  @IsUUID()
  projectWorkflowId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ enum: DISCOVERY_SOURCES, isArray: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? value as unknown[] : [value]))
  @IsArray()
  @IsIn(DISCOVERY_SOURCES, { each: true })
  discoveredBy?: DiscoverySource[];

  @ApiPropertyOptional({ description: 'Inclusive first detection, with legacy creation-date fallback' })
  @IsOptional() @IsDateString({ strict: true })
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'First detection through the end of this UTC day, with legacy creation-date fallback' })
  @IsOptional() @IsDateString({ strict: true })
  createdTo?: string;

  @ApiPropertyOptional({ type: String, description: 'Bounded finding filter tree, using the global finding filter fields and operators' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseFilterParam(value))
  @IsVulnerabilityFilter()
  filter?: VulnerabilityFilter;

  @ApiPropertyOptional({ enum: PROJECT_FINDING_SORTS })
  @IsOptional() @IsIn(PROJECT_FINDING_SORTS)
  sortBy?: (typeof PROJECT_FINDING_SORTS)[number];

  @ApiPropertyOptional({ enum: SortOrder })
  @IsOptional() @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}

export class ProjectFindingDismissalDto {
  @ApiProperty({ type: String, format: 'uuid' }) id: string;
  @ApiProperty({ enum: FINDING_DISMISS_REASONS }) reason: FindingDismissalReason;
  @ApiPropertyOptional({ type: Date }) expiresAt?: Date;
}

export class ProjectFindingSightingDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  runId: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

export class ProjectFindingDto {
  @ApiProperty({ type: String, format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: Severity }) severity: Severity;
  @ApiProperty({ type: String, isArray: true, nullable: true })
  cveId: string[] | null;
  @ApiProperty({ type: String, nullable: true }) affectedUrl: string | null;
  @ApiProperty({ type: String, format: 'uuid' }) assetId: string;
  @ApiProperty() assetValue: string;
  @ApiProperty({ type: String, nullable: true }) toolName: string | null;
  @ApiProperty({
    enum: [VulnerabilityStatus.OPEN, VulnerabilityStatus.DISMISSED, VulnerabilityStatus.FIXED],
    description:
      'Resolution state; fixed takes precedence over dismissal. Proposal review state is identified by the selected review filter. Archived findings are included with status=all.',
  })
  status: VulnerabilityStatus.OPEN | VulnerabilityStatus.DISMISSED | VulnerabilityStatus.FIXED;
  @ApiProperty({ enum: ProjectFindingProvenance })
  provenance: ProjectFindingProvenance;
  @ApiProperty({ type: 'integer', minimum: 0 }) timesSeen: number;
  @ApiProperty({ type: () => ProjectFindingSightingDto })
  firstSeen: ProjectFindingSightingDto;
  @ApiProperty({ type: () => ProjectFindingSightingDto })
  lastSeen: ProjectFindingSightingDto;

  @ApiProperty({ enum: REVIEW_STATUSES }) reviewStatus: ReviewStatus;
  @ApiProperty({ enum: PUBLIC_DETECTION_STATUSES }) detectionStatus: (typeof PUBLIC_DETECTION_STATUSES)[number];
  @ApiProperty({ enum: DISCOVERY_SOURCES }) discoveredBy: DiscoverySource;
  @ApiProperty() isArchived: boolean;
  @ApiProperty({ type: Date, nullable: true }) firstDetectedDate: Date | null;
  @ApiProperty({ type: Date, nullable: true }) lastSeenDate: Date | null;
  @ApiProperty({ type: Date, nullable: true }) dueAt: Date | null;
  @ApiProperty({ type: Date, nullable: true }) fixClaimedAt: Date | null;
  @ApiProperty({ type: ProjectFindingDismissalDto, nullable: true })
  vulnerabilityDismissal: ProjectFindingDismissalDto | null;
}

export class ProjectFindingStatisticsDto extends PickType(GetVulnerabilitiesStatisticsResponseDto, [
  'data', 'byDetectionStatus', 'newLast7Days', 'resurfacedLast30Days', 'fixedLast30Days', 'overdue', 'mttr',
] as const) {
  @ApiProperty({ type: Number, nullable: true, description: 'Null without effective vulnerability read access' })
  pendingReview: number | null;
}

export class ProjectFindingProvenanceCountsDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) all: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) new: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) recurring: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) notSeen: number;
}

export class ProjectFindingsResponseDto extends GetManyBaseResponseDto<ProjectFindingDto> {
  @ApiProperty({ isArray: true, type: () => ProjectFindingDto })
  declare data: ProjectFindingDto[];

  @ApiProperty({
    type: () => ProjectFindingProvenanceCountsDto,
    description: 'Counts under every filter except provenance',
  })
  provenanceCounts: ProjectFindingProvenanceCountsDto;

  @ApiProperty({
    type: () => SeverityCountsDto,
    description: 'Counts under every filter except severity',
  })
  severityCounts: SeverityCountsDto;
}
