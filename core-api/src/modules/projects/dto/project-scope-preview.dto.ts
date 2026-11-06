import {
  ProjectScopeRuleMode,
  ProjectScopeRuleType,
} from '@/common/enums/enum';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class ScopeRuleInputDto {
  @ApiProperty({ enum: ProjectScopeRuleMode, enumName: 'ProjectScopeRuleMode' })
  @IsEnum(ProjectScopeRuleMode)
  mode: ProjectScopeRuleMode;

  @ApiProperty({ enum: ProjectScopeRuleType, enumName: 'ProjectScopeRuleType' })
  @IsEnum(ProjectScopeRuleType)
  type: ProjectScopeRuleType;

  @ApiProperty({
    description:
      'Target/asset UUID, hostname pattern with * wildcards, or IPv4/IPv6 CIDR',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  value: string;
}

export class ScopePreviewDto {
  @ApiProperty({ type: [ScopeRuleInputDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ScopeRuleInputDto)
  rules: ScopeRuleInputDto[];

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'Include the owned manual members of this project',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID()
  projectId?: string;
}

export class ScopePreviewResultDto {
  @ApiProperty({
    description: 'Selected rule assets union owned manual members',
    type: 'integer',
    minimum: 0,
  })
  total: number;

  @ApiProperty({
    description: 'Assets selected by include rules after exclusions',
    type: 'integer',
    minimum: 0,
  })
  ruleAssets: number;

  @ApiProperty({
    type: [Number],
    description:
      'Per original input row: include matches, or include matches removed by an exclusion',
  })
  perRule: number[];
}
