import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import {
  ProjectAssetSource,
  ProjectScopeRuleType,
  TargetType,
} from '@/common/enums/enum';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import type { ProjectAssetView } from '../project-asset-read.service';

export class GetProjectAssetsQueryDto extends GetManyBaseQueryParams {
  @ApiProperty({
    required: false,
    enum: ProjectAssetSource,
    enumName: 'ProjectAssetSource',
  })
  @IsOptional()
  @IsEnum(ProjectAssetSource)
  source?: ProjectAssetSource;
}

export class SeverityCountsDto {
  @ApiProperty({ minimum: 0 }) critical: number;
  @ApiProperty({ minimum: 0 }) high: number;
  @ApiProperty({ minimum: 0 }) medium: number;
  @ApiProperty({ minimum: 0 }) low: number;
  @ApiProperty({ minimum: 0 }) info: number;
}

export class ProjectAssetRuleDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ProjectScopeRuleType, enumName: 'ProjectScopeRuleType' })
  type: ProjectScopeRuleType;
  @ApiProperty() value: string;
  @ApiProperty() label: string;
}

export class ProjectAssetScanDto {
  @ApiProperty({ format: 'uuid' }) runId: string;
  @ApiProperty({ type: Date }) createdAt: Date;
}

export class ProjectAssetDto implements ProjectAssetView {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() value: string;
  @ApiProperty({ format: 'uuid' }) targetId: string;
  @ApiProperty() targetValue: string;
  @ApiProperty({ enum: TargetType, enumName: 'TargetType' })
  targetType: TargetType;
  @ApiProperty({ enum: ProjectAssetSource, enumName: 'ProjectAssetSource' })
  source: ProjectAssetSource;
  @ApiProperty({ type: () => ProjectAssetRuleDto, nullable: true })
  rule: ProjectAssetRuleDto | null;
  @ApiProperty({ type: Date, description: 'When the asset joined the project' })
  addedAt: Date;
  @ApiProperty({
    type: () => SeverityCountsDto,
    description: 'Open findings linked to this project',
  })
  vulnerabilities: SeverityCountsDto;
  @ApiProperty({ type: () => ProjectAssetScanDto, nullable: true })
  lastScan: ProjectAssetScanDto | null;
}
