import { ARTIFACT_UPLOAD_TTL_SECONDS, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { StorageService } from '@/modules/storage/storage.service';
import { Lock } from '@/services/redis/lock.decorator';
import { RedisService } from '@/services/redis/redis.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource, In, type Repository } from 'typeorm';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

export const ARTIFACT_STAGING_CURSOR = 'artifacts:staging-sweep:cursor:v1';

@Injectable()
export class ArtifactStagingSweepService {
  private readonly logger = new Logger(ArtifactStagingSweepService.name);

  constructor(
    @InjectRepository(WorkspaceArtifact)
    private readonly artifacts: Repository<WorkspaceArtifact>,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
  ) {}

  /** Resume the bounded scan across replicas and restart after the last page. */
  @Cron('*/2 * * * *', { name: 'artifact-staging-sweep' })
  @Lock('cron:artifact-staging-sweep', { ttl: 60_000 })
  async run(): Promise<void> {
    await this.sweepPage(new Date(Date.now() - ARTIFACT_UPLOAD_TTL_SECONDS * 1000));
  }

  /** Retry storage cleanup after a workspace cascade or late staging write. */
  async sweepPage(cutoff: Date): Promise<void> {
    const cursor = await this.redis.get(ARTIFACT_STAGING_CURSOR);
    const { objects, nextKey } = await this.storage.listArtifactSweepPage(cursor ?? undefined);
    const candidates = objects.flatMap(({ Key: key, LastModified: modified }) => {
      if (!key || !modified || !(modified < cutoff)) return [];
      const [, workspaceId, artifactId] = key.split('/');
      if (!isUUID(workspaceId) || !key.startsWith(`workspaces/${workspaceId.toLowerCase()}/`)) return [];
      return [{ key, workspaceId, artifactId }];
    });

    if (candidates.length) {
      // A committed deletion proves the workspace owned this prefix. Absence
      // alone could also mean the database was restored or configured wrongly.
      const removed = await this.dataSource.query<{ workspaceId: string }[]>(
        `SELECT DISTINCT ae."workspaceId"
         FROM audit_events ae
         WHERE ae."workspaceId" = ANY($1::uuid[]) AND ae."resourceId" = ae."workspaceId"
           AND ae.action = 'workspace.deleted' AND ae."resourceType" = 'workspace' AND ae.outcome = 'success'
           AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ae."workspaceId")`,
        [[...new Set(candidates.map(({ workspaceId }) => workspaceId))]],
      );
      const deletedWorkspaces = new Set(removed.map(({ workspaceId }) => workspaceId));
      const staging = candidates.filter(({ key, workspaceId, artifactId }) =>
        !deletedWorkspaces.has(workspaceId) && isUUID(artifactId) && key === workspaceArtifactUploadKey(workspaceId, artifactId));
      // Reservation commits before Argus returns the signed form. An upload
      // old enough to appear here cannot acquire a new reservation for its ID.
      const rows = staging.length ? await this.artifacts.find({
        where: { id: In(staging.map(({ artifactId }) => artifactId)) },
        select: { id: true, workspaceId: true },
      }) : [];
      const tracked = new Set(rows.map(row => workspaceArtifactUploadKey(row.workspaceId, row.id)));
      const orphans = [
        ...candidates.filter(({ workspaceId }) => deletedWorkspaces.has(workspaceId)),
        ...staging.filter(({ key }) => !tracked.has(key)),
      ];
      if (orphans.length) {
        const failed = await this.storage.deleteArtifactSweepObjects(orphans.map(({ key }) => key));
        if (failed) this.logger.warn(`${failed} artifact object(s) could not be removed; the next scan will retry`);
      }
    }

    // A per-object failure must not prevent later pages from being scanned.
    if (nextKey) await this.redis.set(ARTIFACT_STAGING_CURSOR, nextKey);
    else await this.redis.del(ARTIFACT_STAGING_CURSOR);
  }
}
