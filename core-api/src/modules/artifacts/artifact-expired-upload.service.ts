import { StorageService } from '@/modules/storage/storage.service';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { ArtifactQuotaService } from './artifact-quota.service';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

export const UPLOAD_EXPIRY_GRACE_MS = 15 * 60_000;

@Injectable()
export class ArtifactExpiredUploadService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly quota: ArtifactQuotaService,
  ) {}

  /** Reclaim one expired pending upload selected by the internal sweeper. */
  async reclaim({ workspaceId, artifactId }: { workspaceId: string; artifactId: string }): Promise<boolean> {
    if (![workspaceId, artifactId].every(id => typeof id === 'string' && id.length === 36 && isUUID(id))) {
      return false;
    }
    return this.dataSource.transaction(async manager => {
      // Let the scheduler move on when another transaction holds a lock.
      await manager.query("SET LOCAL lock_timeout = '2s'");
      const workspace = await manager.findOne(Workspace, {
        where: { id: workspaceId },
        select: { id: true },
        lock: { mode: 'for_key_share' },
      });
      if (!workspace) return false;

      const repo = manager.getRepository(WorkspaceArtifact);
      const artifact = await repo.findOne({
        where: { id: artifactId, workspaceId: workspace.id, source: 'upload', status: 'pending' },
        lock: { mode: 'pessimistic_write' },
      });
      // Recheck under the same row lock as completion. Allow time for requests
      // that started while the signed form was still valid to finish.
      // The orphan staging sweep removes objects written after reclamation.
      if (!artifact?.expiresAt || artifact.expiresAt.getTime() + UPLOAD_EXPIRY_GRACE_MS > Date.now()) {
        return false;
      }

      // A failed completion may have left a verified copy at the final key.
      // Keep the reservation and row until both objects are gone.
      await this.storage.deleteArtifactUploadObjects({ workspaceId: workspace.id, artifactId: artifact.id });
      if (!(await this.quota.releaseReserved(manager, workspace.id, Number(artifact.sizeBytes)))) {
        throw new InternalServerErrorException('Artifact reservation could not be reclaimed');
      }
      await repo.delete(artifact.id);
      return true;
    });
  }
}
