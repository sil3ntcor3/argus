import { User } from '@/modules/auth/entities/user.entity';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';

/** Private record for a file in the artifacts bucket. */
@Entity('artifacts')
@Unique('UQ_artifacts_object_key', ['objectKey'])
@Index('IDX_artifacts_workspace_created', ['workspaceId', 'createdAt'])
@Index('IDX_artifacts_creator', ['createdByUserId'])
@Index('IDX_artifacts_status_expires', ['status', 'expiresAt'])
@Check('CHK_artifacts_size_bytes', '"sizeBytes" BETWEEN 0 AND 9007199254740991')
@Check('CHK_artifacts_source', `"source" IN ('upload', 'agent')`)
@Check('CHK_artifacts_status', `"status" IN ('pending', 'ready', 'deleted')`)
@Check('CHK_artifacts_pending_expiry', `"status" <> 'pending' OR "expiresAt" IS NOT NULL`)
@Check('CHK_artifacts_metadata', `jsonb_typeof("metadata") = 'object'`)
@Check(
  'CHK_artifacts_object_key',
  `"objectKey" = ('workspaces/' || "workspaceId"::text || '/' || "id"::text || '/file')`,
)
export class WorkspaceArtifact {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_artifacts_id' })
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @ManyToOne(() => Workspace, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspaceId', foreignKeyConstraintName: 'FK_artifacts_workspace' })
  workspace: Relation<Workspace>;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'createdByUserId', foreignKeyConstraintName: 'FK_artifacts_creator' })
  createdBy: Relation<User> | null;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  mimeType: string;

  /** Allocate the UUID before insert; user-supplied names never form object keys. */
  @Column({ type: 'text' })
  objectKey: string;

  @Column({ type: 'bigint' })
  sizeBytes: string;

  @Column({ type: 'varchar', default: 'upload' })
  source: 'upload' | 'agent';

  @Column({ type: 'varchar', default: 'pending' })
  status: 'pending' | 'ready' | 'deleted';

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
