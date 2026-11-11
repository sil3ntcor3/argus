import { User } from '@/modules/auth/entities/user.entity';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';

/** A private folder record scoped to a single workspace. */
@Entity('artifact_folders')
@Unique('UQ_artifact_folders_workspace_id', ['workspaceId', 'id'])
@Index('IDX_artifact_folders_workspace_parent', ['workspaceId', 'parentFolderId'])
@Index('IDX_artifact_folders_creator', ['createdByUserId'])
@ForeignKey(() => ArtifactFolder, ['workspaceId', 'parentFolderId'], ['workspaceId', 'id'], {
  name: 'FK_artifact_folders_parent',
  onDelete: 'NO ACTION',
})
export class ArtifactFolder {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_artifact_folders_id' })
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @ManyToOne(() => Workspace, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspaceId', foreignKeyConstraintName: 'FK_artifact_folders_workspace' })
  workspace: Relation<Workspace>;

  /** Null places the folder at the workspace root. */
  @Column({ type: 'uuid', nullable: true })
  parentFolderId: string | null;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'createdByUserId', foreignKeyConstraintName: 'FK_artifact_folders_creator' })
  createdBy: Relation<User> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
