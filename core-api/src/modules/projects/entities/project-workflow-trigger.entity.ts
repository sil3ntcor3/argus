import { BaseEntity } from '@/common/entities/base.entity';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Relation,
} from 'typeorm';

/** Private storage for later trigger management; existing schedules stay on bindings. */
@Entity('project_workflow_triggers')
@Index('IDX_pwt_projectWorkflowId', ['projectWorkflowId'])
export class ProjectWorkflowTrigger extends BaseEntity {
  @Column({ type: 'uuid' })
  projectWorkflowId: string;

  @ManyToOne(() => AssetGroupWorkflow, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectWorkflowId' })
  projectWorkflow: Relation<AssetGroupWorkflow>;

  @Column({ type: 'varchar' })
  type: 'cron' | 'event';

  @Column({ type: 'varchar', nullable: true })
  cron: string | null;

  @Column({ type: 'varchar', nullable: true })
  event: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  config: Record<string, unknown>;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastFiredAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  schedulerId: string | null;
}
