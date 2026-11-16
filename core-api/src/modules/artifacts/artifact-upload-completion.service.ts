import { StorageService } from '@/modules/storage/storage.service';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { ArtifactQuotaService } from './artifact-quota.service';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

interface CompleteArtifactUpload {
  workspaceId: string;
  userId: string;
  artifactId: string;
  source?: WorkspaceArtifact['source'];
  abortSignal?: AbortSignal;
}

@Injectable()
export class ArtifactUploadCompletionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly quota: ArtifactQuotaService,
  ) {}

  /** Finalize an upload owned by the authorized caller. */
  async completeUpload({ workspaceId, userId, artifactId, source = 'upload', abortSignal }: CompleteArtifactUpload): Promise<WorkspaceArtifact> {
    abortSignal?.throwIfAborted();
    if (![workspaceId, userId, artifactId].every(id => typeof id === 'string' && id.length === 36 && isUUID(id))) {
      throw new NotFoundException('Artifact not found');
    }
    return this.dataSource.transaction(async manager => {
      // Match the lock order used for workspace deletion and its cascades.
      const workspace = await manager.findOne(Workspace, {
        where: { id: workspaceId },
        select: { id: true },
        lock: { mode: 'for_key_share' },
      });
      if (!workspace) throw new NotFoundException('Artifact not found');

      const repo = manager.getRepository(WorkspaceArtifact);
      const artifact = await repo.findOne({
        where: { id: artifactId, workspaceId: workspace.id, createdByUserId: userId, source },
        lock: { mode: 'pessimistic_write' },
      });
      abortSignal?.throwIfAborted();
      if (!artifact || artifact.status === 'deleted') throw new NotFoundException('Artifact not found');
      if (artifact.status === 'ready') return artifact;
      if (!artifact.expiresAt || artifact.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException('Artifact upload expired');
      }

      const sizeBytes = Number(artifact.sizeBytes);
      // If accounting or commit fails, the final key remains private; the
      // publish helper can recognize the same copy on a later retry.
      await this.storage.publishArtifactUpload({
        workspaceId: artifact.workspaceId, artifactId: artifact.id, contentType: artifact.mimeType, sizeBytes,
      });
      abortSignal?.throwIfAborted();
      if (!(await this.quota.commit(manager, artifact.workspaceId, sizeBytes))) {
        throw new InternalServerErrorException('Artifact reservation could not be settled');
      }
      artifact.status = 'ready';
      // Keep the deadline for a separate cleanup of the replayable staging key.
      await repo.save(artifact);
      abortSignal?.throwIfAborted();
      return artifact;
    });
  }
}
