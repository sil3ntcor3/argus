import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsBoolean, ValidateIf } from 'class-validator';
import { ScopePreviewDto } from './project-scope-preview.dto';

export class ReplaceScopeRulesDto extends PickType(ScopePreviewDto, [
  'rules',
] as const) {
  @ApiProperty({ required: false, type: Boolean })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  autoAddAssets?: boolean;
}

export class ScopeSyncResultDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  added: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  removed: number;
}
