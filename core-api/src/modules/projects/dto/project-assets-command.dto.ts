import { ApiProperty } from '@nestjs/swagger';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { AddManyAssetsToAssetGroupDto } from '@/modules/asset-group/dto/add-many-assets-to-asset-group.dto';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class AddProjectAssetsDto extends AddManyAssetsToAssetGroupDto {}

export class RemoveProjectAssetsDto {
  @ApiProperty({
    description: 'Asset IDs to remove',
    type: [String],
    maxItems: 1000,
    uniqueItems: true,
    example: ['123e4567-e89b-12d3-a456-426614174001'],
  })
  @IsArray()
  @IsUUID(undefined, { each: true })
  @ArrayUnique()
  @ArrayMaxSize(1000)
  assetIds: string[];
}

export class ProjectAssetsChangedDto extends DefaultMessageResponseDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  count: number;
}
