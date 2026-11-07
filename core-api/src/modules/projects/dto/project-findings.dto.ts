import {
  GetManyBaseQueryParams,
  GetManyBaseResponseDto,
} from '@/common/dtos/get-many-base.dto';
import { Severity } from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
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
    description: 'Open excludes archived and dismissed findings',
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
    enum: [VulnerabilityStatus.OPEN, VulnerabilityStatus.DISMISSED],
    description:
      'Dismissal state. Archived findings without a dismissal can be returned with status=all.',
  })
  status: VulnerabilityStatus.OPEN | VulnerabilityStatus.DISMISSED;
  @ApiProperty({ enum: ProjectFindingProvenance })
  provenance: ProjectFindingProvenance;
  @ApiProperty({ type: 'integer', minimum: 0 }) timesSeen: number;
  @ApiProperty({ type: () => ProjectFindingSightingDto })
  firstSeen: ProjectFindingSightingDto;
  @ApiProperty({ type: () => ProjectFindingSightingDto })
  lastSeen: ProjectFindingSightingDto;
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
