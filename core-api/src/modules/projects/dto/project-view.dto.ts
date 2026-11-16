import { ApiProperty, PickType } from '@nestjs/swagger';
import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';

// PickType copies property metadata, without inheriting the entity's private toJSON.
export class ProjectViewDto extends PickType(AssetGroup, [
  'id',
  'createdAt',
  'updatedAt',
  'name',
  'hexColor',
  'totalAssets',
  'lastRunAt',
  'assetGroupWorkflows',
] as const) {
  @ApiProperty({ type: String, nullable: true, readOnly: true })
  description: string | null;

  @ApiProperty({ type: String, nullable: true, readOnly: true })
  instruction: string | null;

  @ApiProperty({ type: Boolean, readOnly: true })
  autoAddAssets: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, readOnly: true })
  archivedAt: Date | null;
}
