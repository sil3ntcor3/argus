import { GetAllAssetGroupsQueryDto } from '@/modules/asset-group/dto/get-all-asset-groups-dto.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional } from 'class-validator';

export class GetProjectsQueryDto extends GetAllAssetGroupsQueryDto {
  @ApiProperty({ required: false, description: 'Sort field; risk orders open critical/high/medium counts and requires vulnerability read access' })
  declare sortBy: string;
  @IsInt() declare page: number;
  @IsInt() declare limit: number;
  @ApiProperty({
    required: false,
    enum: ['active', 'archived', 'all'],
    default: 'active',
  })
  @IsOptional()
  @IsIn(['active', 'archived', 'all'])
  status?: 'active' | 'archived' | 'all' = 'active';
}
