import { GetManyBaseQueryParams, SortOrder } from '@/common/dtos/get-many-base.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, NotContains } from 'class-validator';
import type { WorkspaceArtifact } from '../entities/workspace-artifact.entity';

export const ARTIFACT_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'sizeBytes'] as const;
export enum ArtifactListScope {
  MINE = 'mine',
  ALL = 'all',
}

export class ArtifactListQueryDto extends GetManyBaseQueryParams {
  @ApiPropertyOptional({ enum: ArtifactListScope, default: ArtifactListScope.MINE })
  @IsOptional()
  @IsIn(Object.values(ArtifactListScope))
  scope: ArtifactListScope = ArtifactListScope.MINE;

  @ApiPropertyOptional({ type: 'integer', default: 1, minimum: 1, maximum: 1_000_000 })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  override page: number = 1;

  @ApiPropertyOptional({ type: 'integer', default: 10, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  override limit: number = 10;

  @ApiPropertyOptional({ enum: ARTIFACT_SORT_FIELDS, default: 'createdAt' })
  @IsIn(ARTIFACT_SORT_FIELDS)
  override sortBy: (typeof ARTIFACT_SORT_FIELDS)[number] = 'createdAt';

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.ASC, example: SortOrder.ASC })
  @IsEnum(SortOrder)
  override sortOrder: SortOrder = SortOrder.ASC;

  @ApiPropertyOptional({ maxLength: 255, description: 'Case-insensitive literal substring of the file name.' })
  @IsString()
  @MaxLength(255)
  @NotContains('\0')
  override search: string = '';
}

export class ArtifactListCreatorDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  image: string | null;
}

export class ArtifactListItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  mimeType: string;

  @ApiProperty({ minimum: 0 })
  sizeBytes: number;

  @ApiProperty({ enum: ['upload', 'agent'] })
  source: WorkspaceArtifact['source'];

  @ApiProperty({ type: ArtifactListCreatorDto, nullable: true })
  createdBy: ArtifactListCreatorDto | null;

  @ApiProperty()
  isOwner: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
