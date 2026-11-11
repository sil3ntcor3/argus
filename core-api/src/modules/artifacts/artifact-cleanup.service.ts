import { StorageService } from '@/modules/storage/storage.service';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { ArtifactQuotaService } from './artifact-quota.service';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

export const UPLOAD_EXPIRY_GRACE_MS = 15 * 60_000;
type ArtifactLocation = { workspaceId: string; artifactId: string };

@Injectable()
export class ArtifactCleanupService {
  private readonly logger = new Logger(ArtifactCleanupService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly quota: ArtifactQuotaService,
  ) {}

  async remove(location: ArtifactLocation, userId: string, permissions: string[]): Promise<{ message: string }> {
    const { workspaceId, artifactId } = location;
    const artifacts = this.dataSource.getRepository(WorkspaceArtifact);
    const manage = permissions.includes('artifact.manage') || permissions.includes('*');
    const visible = {
      id: artifactId, workspaceId, status: 'ready' as const,
      ...(manage ? {} : { createdByUserId: userId }),
    };
    if (!manage && !permissions.includes('artifact.write')) {
      if (!(await artifacts.existsBy(visible))) throw new NotFoundException('File not found');
      throw new ForbiddenException('Requires artifact.write');
    }

    // Commit the tombstone before I/O so a partial purge cannot expose a missing file.
    const { affected } = await artifacts.update(visible, { status: 'deleted' });
    if (affected !== 1) throw new NotFoundException('File not found');
    try {
      await this.purgeDeleted(location);
    } catch (error) {
      this.logger.warn(`Deferred cleanup of deleted artifact ${artifactId}`, error);
    }
    return { message: 'File deleted' };
  }

  /** Reclaim one expired pending upload selected by the internal sweeper. */
  reclaim(location: ArtifactLocation): Promise<boolean> {
    return this.purge(location, 'pending');
  }

  purgeDeleted(location: ArtifactLocation): Promise<boolean> {
    return this.purge(location, 'deleted');
  }

  private async purge({ workspaceId, artifactId }: ArtifactLocation, status: 'pending' | 'deleted'): Promise<boolean> {
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
      if (!workspace) {
        if (status === 'pending') return false;
        // A workspace cascade can remove a selected tombstone before we acquire
        // the lock. The committed transition or sweep still identifies its keys.
        await this.storage.deleteArtifactUploadObjects({ workspaceId, artifactId });
        return true;
      }

      const repo = manager.getRepository(WorkspaceArtifact);
      const artifact = await repo.findOne({
        where: { id: artifactId, workspaceId: workspace.id, status },
        lock: { mode: 'pessimistic_write' },
      });
      // Recheck under the same row lock as completion. Allow time for requests
      // that started while the signed form was still valid to finish.
      // The orphan staging sweep removes objects written after reclamation.
      if (!artifact || (status === 'pending' &&
          (!artifact.expiresAt || artifact.expiresAt.getTime() + UPLOAD_EXPIRY_GRACE_MS > Date.now()))) {
        return false;
      }

      // A signed POST can only write staging. The orphan sweep handles late replays.
      // Keep the row and its charge until both keys have been removed.
      await this.storage.deleteArtifactUploadObjects({ workspaceId: workspace.id, artifactId: artifact.id });
      const bytes = Number(artifact.sizeBytes);
      const released = status === 'pending'
        ? await this.quota.releaseReserved(manager, workspace.id, bytes)
        : await this.quota.releaseUsed(manager, workspace.id, bytes);
      if (!released) {
        throw new InternalServerErrorException('Artifact quota could not be reclaimed');
      }
      await repo.delete(artifact.id);
      return true;
    });
  }
}
