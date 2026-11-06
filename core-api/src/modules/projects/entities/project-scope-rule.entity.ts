import { BaseEntity } from '@/common/entities/base.entity';
import {
  ProjectScopeRuleMode,
  ProjectScopeRuleType,
} from '@/common/enums/enum';
import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Relation,
} from 'typeorm';

/** Private persistence; matching and public scope management follow separately. */
@Entity('project_scope_rules')
@Index('IDX_psr_projectId', ['projectId'])
export class ProjectScopeRule extends BaseEntity {
  @Column({ type: 'uuid' })
  projectId: string;

  @ManyToOne(() => AssetGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Relation<AssetGroup>;

  @Column({ type: 'varchar' })
  mode: ProjectScopeRuleMode;

  @Column({ type: 'varchar' })
  type: ProjectScopeRuleType;

  @Column({ type: 'varchar' })
  value: string;
}
