import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { Severity } from '@/common/enums/enum';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export enum TargetChangeKind {
  ASSET = 'asset',
  SERVICE = 'service',
  VULNERABILITY = 'vulnerability',
}

export class GetTargetChangesQueryDto extends PickType(GetManyBaseQueryParams, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  declare page: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 10,
  })
  declare limit: number;

  @ApiPropertyOptional({ enum: TargetChangeKind, enumName: 'TargetChangeKind' })
  @IsOptional()
  @IsEnum(TargetChangeKind)
  kind?: TargetChangeKind;
}

export class TargetChangeDto {
  @ApiProperty({ enum: TargetChangeKind, enumName: 'TargetChangeKind' })
  kind: TargetChangeKind;

  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty()
  label: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Parent asset value for a service or finding',
  })
  assetValue: string | null;

  @ApiPropertyOptional({ enum: Severity, enumName: 'Severity' })
  severity?: Severity;
}
