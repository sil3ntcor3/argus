import { ApiProperty } from '@nestjs/swagger';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { AddManyAssetsToAssetGroupDto } from '@/modules/asset-group/dto/add-many-assets-to-asset-group.dto';

export class AddProjectAssetsDto extends AddManyAssetsToAssetGroupDto {}

export class ProjectAssetsChangedDto extends DefaultMessageResponseDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  count: number;
}
