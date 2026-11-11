import { User } from '@/modules/auth/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { WorkspaceArtifact } from './workspace-artifact.entity';

/** A private file-recipient record. */
@Entity('artifact_shares')
@Unique('UQ_artifact_shares_artifact_user', ['artifactId', 'userId'])
@Index('IDX_artifact_shares_user', ['userId'])
export class ArtifactShare {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_artifact_shares_id' })
  id: string;

  @Column({ type: 'uuid' })
  artifactId: string;

  @ManyToOne(() => WorkspaceArtifact, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artifactId', foreignKeyConstraintName: 'FK_artifact_shares_artifact' })
  artifact: Relation<WorkspaceArtifact>;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_artifact_shares_user' })
  user: Relation<User>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
