import { Lock } from '@/services/redis/lock.decorator';
import { RedisService } from '@/services/redis/redis.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { ArtifactCleanupService, UPLOAD_EXPIRY_GRACE_MS } from './artifact-cleanup.service';

const PAGE_SIZE = 25;
export const ARTIFACT_EXPIRY_CURSOR = 'artifacts:reservation-expiry:cursor:v1';

type CleanupCandidate = { id: string; workspaceId: string; status: 'pending' | 'deleted'; dueAt: string };

@Injectable()
export class ArtifactExpirySweepService {
  private readonly logger = new Logger(ArtifactExpirySweepService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cleanup: ArtifactCleanupService,
    private readonly redis: RedisService,
  ) {}

  /** Schedule one bounded page across the API replicas. */
  @Cron('30 */2 * * * *', { name: 'artifact-reservation-expiry', waitForCompletion: true })
  @Lock('cron:artifact-reservation-expiry', { ttl: 10 * 60_000 })
  async run(): Promise<void> {
    await this.sweepPage();
  }

  /** Revisit failed or newly eligible rows when the cursor wraps. */
  async sweepPage(): Promise<void> {
    const cursor = await this.redis.get(ARTIFACT_EXPIRY_CURSOR);
    const [dueAt, id, startedAt] = cursor?.split('|') ?? [];
    const validCursor = Number.isFinite(Date.parse(dueAt)) && isUUID(id);
    // Freeze eligibility for each traversal so new arrivals cannot prevent a wrap.
    const cycleStart = new Date(validCursor && Number.isFinite(Date.parse(startedAt))
      ? Date.parse(startedAt) : Date.now());
    const cutoff = new Date(cycleStart.getTime() - UPLOAD_EXPIRY_GRACE_MS);
    // Keep PostgreSQL's timestamp precision in the cursor across pages.
    const due = await this.dataSource.query<CleanupCandidate[]>(
      `SELECT id, "workspaceId", status, "dueAt"::text AS "dueAt"
       FROM (
         SELECT id, "workspaceId", status, "expiresAt" AS "dueAt" FROM artifacts
         WHERE status = 'pending' AND "expiresAt" <= $1
         UNION ALL
         SELECT id, "workspaceId", status, "createdAt" AS "dueAt" FROM artifacts
         WHERE status = 'deleted' AND "updatedAt" <= $5
       ) candidates
       WHERE $2::timestamptz IS NULL OR ("dueAt", id) > ($2, $3::uuid)
       ORDER BY candidates."dueAt", id
       LIMIT $4`,
      [cutoff, validCursor ? dueAt : null, validCursor ? id : null, PAGE_SIZE, cycleStart],
    );

    for (const { id: artifactId, workspaceId, status } of due) {
      try {
        if (status === 'deleted') await this.cleanup.purgeDeleted({ artifactId, workspaceId });
        else await this.cleanup.reclaim({ artifactId, workspaceId });
      } catch (error) {
        this.logger.warn(`Could not clean up ${status} artifact ${artifactId}`, error);
      }
    }

    const last = due.at(-1);
    if (last && due.length === PAGE_SIZE) {
      await this.redis.set(ARTIFACT_EXPIRY_CURSOR, `${last.dueAt}|${last.id}|${cycleStart.toISOString()}`);
    } else {
      await this.redis.del(ARTIFACT_EXPIRY_CURSOR);
    }
  }
}
