import {
  ProjectScopeRuleMode,
  ProjectScopeRuleType,
} from '@/common/enums/enum';
import { ApiProperty } from '@nestjs/swagger';

export class ScopeRuleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ProjectScopeRuleMode, enumName: 'ProjectScopeRuleMode' })
  mode: ProjectScopeRuleMode;

  @ApiProperty({ enum: ProjectScopeRuleType, enumName: 'ProjectScopeRuleType' })
  type: ProjectScopeRuleType;

  @ApiProperty()
  value: string;

  @ApiProperty({
    description: 'Owned target/asset name, or the stored rule value',
  })
  label: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      'Include matches, or include matches removed by this exclusion',
  })
  matched: number;
}

export class ProjectScopeDto {
  @ApiProperty({ type: [ScopeRuleDto] })
  rules: ScopeRuleDto[];

  @ApiProperty({
    description: 'Saved preference for automatic asset membership',
  })
  autoAddAssets: boolean;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Current owned members with rule provenance',
  })
  ruleAssets: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Current owned members with manual provenance',
  })
  manualAssets: number;
}
