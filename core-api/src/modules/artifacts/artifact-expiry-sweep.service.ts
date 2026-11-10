import { Lock } from '@/services/redis/lock.decorator';
import { RedisService } from '@/services/redis/redis.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { ArtifactExpiredUploadService, UPLOAD_EXPIRY_GRACE_MS } from './artifact-expired-upload.service';

const PAGE_SIZE = 25;
export const ARTIFACT_EXPIRY_CURSOR = 'artifacts:reservation-expiry:cursor:v1';

type ExpiryCandidate = { id: string; workspaceId: string; expiresAt: string };

@Injectable()
export class ArtifactExpirySweepService {
  private readonly logger = new Logger(ArtifactExpirySweepService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly expiry: ArtifactExpiredUploadService,
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
    const cutoff = new Date(Date.now() - UPLOAD_EXPIRY_GRACE_MS);
    const cursor = await this.redis.get(ARTIFACT_EXPIRY_CURSOR);
    const [expiresAt, id] = cursor?.split('|') ?? [];
    const validCursor = Number.isFinite(Date.parse(expiresAt)) && isUUID(id);
    // Keep PostgreSQL's timestamp precision in the cursor across pages.
    const due = await this.dataSource.query<ExpiryCandidate[]>(
      `SELECT id, "workspaceId", "expiresAt"::text AS "expiresAt"
       FROM artifacts
       WHERE status = 'pending' AND source = 'upload' AND "expiresAt" <= $1
         AND ($2::timestamptz IS NULL OR ("expiresAt", id) > ($2, $3::uuid))
       ORDER BY "expiresAt", id
       LIMIT $4`,
      [cutoff, validCursor ? expiresAt : null, validCursor ? id : null, PAGE_SIZE],
    );

    for (const { id: artifactId, workspaceId } of due) {
      try {
        await this.expiry.reclaim({ artifactId, workspaceId });
      } catch (error) {
        this.logger.warn(`Could not reclaim artifact reservation ${artifactId}`, error);
      }
    }

    const last = due.at(-1);
    if (last && due.length === PAGE_SIZE) {
      await this.redis.set(ARTIFACT_EXPIRY_CURSOR, `${last.expiresAt}|${last.id}`);
    } else {
      await this.redis.del(ARTIFACT_EXPIRY_CURSOR);
    }
  }
}
