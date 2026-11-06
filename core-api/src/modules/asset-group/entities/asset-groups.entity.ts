import { BaseEntity } from '@/common/entities/base.entity';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  Relation,
  Unique,
} from 'typeorm';
import { AssetGroupAsset } from './asset-groups-assets.entity';
import { AssetGroupWorkflow } from './asset-groups-workflows.entity';

@Unique(['name', 'workspace'])
@Entity('projects')
export class AssetGroup extends BaseEntity {
  @ApiProperty()
  @IsString()
  @IsOptional()
  @Column()
  name: string;

  @ManyToOne(() => Workspace, (workspace) => workspace.id, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'workspaceId' })
  workspace: Relation<Workspace>;

  @ApiProperty({ example: '#78716C', required: false })
  @IsString()
  @IsOptional()
  @Column({ nullable: true, default: '#78716C' }) // stone-500 tailwind css
  hexColor: string;

  // Persistence foundation only; public project metadata follows separately.
  @ApiHideProperty()
  @Column({ type: 'text', nullable: true, select: false })
  description: string | null;

  @ApiHideProperty()
  @Column({ default: true, select: false })
  autoAddAssets: boolean;

  @ApiHideProperty()
  @Column({ type: 'timestamptz', nullable: true, select: false })
  archivedAt: Date | null;

  @OneToMany(
    () => AssetGroupAsset,
    (assetGroupAsset) => assetGroupAsset.assetGroup,
  )
  assetGroupAssets: Relation<AssetGroupAsset[]>;

  @ApiProperty({ type: () => [AssetGroupWorkflow], required: false })
  @OneToMany(
    () => AssetGroupWorkflow,
    (assetGroupWorkflows) => assetGroupWorkflows.assetGroup,
  )
  assetGroupWorkflows: Relation<AssetGroupWorkflow[]>;

  @ApiProperty()
  totalAssets: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, required: false })
  lastRunAt?: Date | null;

  // INSERT RETURNING can populate private defaults even with select:false.
  toJSON(): Record<string, unknown> {
    const response: Record<string, unknown> = {};
    Object.assign(response, this);
    for (const key of ['description', 'autoAddAssets', 'archivedAt']) {
      delete response[key];
    }
    return response;
  }
}
