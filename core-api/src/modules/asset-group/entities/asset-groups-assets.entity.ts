import { BaseEntity } from '@/common/entities/base.entity';
import { ProjectAssetSource } from '@/common/enums/enum';
import { Asset } from '@/modules/assets/entities/assets.entity';
import { ProjectScopeRule } from '@/modules/projects/entities/project-scope-rule.entity';
import { ApiHideProperty } from '@nestjs/swagger';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Relation,
} from 'typeorm';
import { AssetGroup } from './asset-groups.entity';

@Entity('project_assets')
@Index('IDX_pa_projectId', ['assetGroup'])
@Index('IDX_pa_assetId', ['asset'])
export class AssetGroupAsset extends BaseEntity {
  @ManyToOne(() => AssetGroup, (assetGroup) => assetGroup.assetGroupAssets, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'projectId' })
  assetGroup: Relation<AssetGroup>;

  @ManyToOne(() => Asset, (asset) => asset.id, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'assetId' })
  asset: Relation<Asset>;

  @ApiHideProperty()
  @Column({
    type: 'varchar',
    default: ProjectAssetSource.MANUAL,
    select: false,
  })
  source: ProjectAssetSource;

  @ApiHideProperty()
  @Column({ type: 'uuid', nullable: true, select: false })
  scopeRuleId: string | null;

  @ApiHideProperty()
  @ManyToOne(() => ProjectScopeRule, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'scopeRuleId' })
  scopeRule?: Relation<ProjectScopeRule> | null;

  // INSERT RETURNING and explicit relation loads can populate private fields.
  toJSON(): Record<string, unknown> {
    const response: Record<string, unknown> = {};
    Object.assign(response, this);
    for (const key of ['source', 'scopeRuleId', 'scopeRule']) delete response[key];
    return response;
  }
}
