import { GetAllAssetGroupsQueryDto } from '@/modules/asset-group/dto/get-all-asset-groups-dto.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class GetProjectsQueryDto extends GetAllAssetGroupsQueryDto {
  @ApiProperty({
    required: false,
    enum: ['active', 'archived', 'all'],
    default: 'active',
  })
  @IsOptional()
  @IsIn(['active', 'archived', 'all'])
  status?: 'active' | 'archived' | 'all' = 'active';
}
