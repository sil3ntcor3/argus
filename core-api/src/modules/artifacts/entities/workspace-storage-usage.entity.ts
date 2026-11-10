import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { Check, Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { Relation } from 'typeorm';

/** Private meter for the bytes used and held for uploads in one workspace. */
@Entity('workspace_storage_usage')
@Check('CHK_wsu_quota_bytes', '"quotaBytes" IS NULL OR "quotaBytes" BETWEEN 0 AND 9007199254740991')
@Check('CHK_wsu_used_bytes', '"usedBytes" BETWEEN 0 AND 9007199254740991')
@Check('CHK_wsu_reserved_bytes', '"reservedBytes" BETWEEN 0 AND 9007199254740991')
export class WorkspaceStorageUsage {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_wsu_workspace' })
  workspaceId: string;

  @OneToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspaceId', foreignKeyConstraintName: 'FK_wsu_workspace' })
  workspace: Relation<Workspace>;

  // PostgreSQL bigint values are strings until a caller explicitly converts them.
  @Column({ type: 'bigint', nullable: true })
  quotaBytes: string | null;

  @Column({ type: 'bigint', default: 0 })
  usedBytes: string;

  @Column({ type: 'bigint', default: 0 })
  reservedBytes: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
