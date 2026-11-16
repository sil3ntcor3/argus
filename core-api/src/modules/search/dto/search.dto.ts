import { Severity } from '@/common/enums/enum';
import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { Asset } from '@/modules/assets/entities/assets.entity';
import { Target } from '@/modules/targets/entities/target.entity';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class SearchAssetsTargetsDto extends GetManyBaseQueryParams {
  @ApiProperty({ required: true })
  @IsString()
  value: string;

  @ApiProperty({ required: false, example: 10 })
  @Min(1)
  @Max(10)
  @IsNumber()
  @Transform(({ value }) => Number(value))
  @IsOptional()
  limit: number = 10;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  isSaveHistory: boolean;

  @ApiProperty({
    required: false,
    isArray: true,
    enum: Severity,
    maxItems: 5,
    description:
      'Filter the separate finding preview by severity; requires vulnerability read access',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? (value as unknown[]) : [value],
  )
  @IsArray()
  @ArrayMaxSize(5)
  @IsEnum(Severity, { each: true })
  severity?: Severity[];
}

export class FindingSearchAssetDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty()
  value: string;
}

export class FindingSearchResultDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty()
  name: string;
  @ApiProperty({ enum: Severity })
  severity: Severity;
  @ApiProperty({ type: String, nullable: true })
  affectedUrl: string | null;
  @ApiProperty({ type: FindingSearchAssetDto })
  asset: FindingSearchAssetDto;
}
export class SearchData {
  @ApiProperty({
    type: [FindingSearchResultDto],
    maxItems: 5,
    description:
      'Top five approved finding previews; empty without finding access. Independent of target/asset pagination.',
  })
  vulnerabilities: FindingSearchResultDto[];

  @ApiProperty({ type: [Asset] })
  assets: Asset[];

  @ApiProperty({ type: [Target] })
  targets: Target[];
}

export class SearchResponseDto {
  @ApiProperty({ type: SearchData })
  data: SearchData;

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  pageCount: number;

  @ApiProperty()
  hasNextPage: boolean;
}

export class GetManySearchHistoryDto extends GetManyBaseQueryParams {
  @ApiProperty({ required: false, example: 10 })
  @Min(1)
  @Max(10)
  @IsNumber()
  @Transform(({ value }) => Number(value))
  @IsOptional()
  limit: number = 10;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  query: string;
}

export class GetSearchHistoryResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  query: string;

  @ApiProperty()
  workspaceId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
