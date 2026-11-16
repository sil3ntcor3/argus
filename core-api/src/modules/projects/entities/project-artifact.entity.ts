import { BaseEntity } from '@/common/entities/base.entity';
import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import type { Relation } from 'typeorm';

/** A project context attachment; detaching never deletes the workspace file. */
@Entity('project_artifacts')
@Unique('UQ_project_artifacts_projectId_artifactId', ['projectId', 'artifactId'])
@Index('IDX_project_artifacts_artifactId', ['artifactId'])
export class ProjectArtifact extends BaseEntity {
  @Column({ type: 'uuid' }) projectId: string;
  @ManyToOne(() => AssetGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' }) project: Relation<AssetGroup>;
  @Column({ type: 'uuid' }) artifactId: string;
  @ManyToOne(() => WorkspaceArtifact, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artifactId' }) artifact: Relation<WorkspaceArtifact>;
}
