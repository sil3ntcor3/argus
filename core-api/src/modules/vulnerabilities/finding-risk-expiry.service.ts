import { Lock } from '@/services/redis/lock.decorator';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

const BATCH_SIZE = 500;
const MAX_BATCHES = 10;
type ExpiryCursor = { expiresAt: string; id: string };
type ExpiryPage = {
  count: number;
  examined: number;
  next: ExpiryCursor | null;
};

@Injectable()
export class FindingRiskExpiryService {
  private readonly logger = new Logger(FindingRiskExpiryService.name);

  constructor(private readonly dataSource: DataSource) {}

  /** Record and remove due acceptances without changing archived findings. */
  private async expireBatch(
    now: Date,
    after: ExpiryCursor | null,
  ): Promise<ExpiryPage> {
    // Lock event parents before deleting dismissals. Skip rows being changed
    // or removed; a later sweep can check them again.
    const [result] = await this.dataSource.query<ExpiryPage[]>(
      `WITH due AS MATERIALIZED (
         SELECT dismissal.id, dismissal."vulnerabilityId", target."workspaceId", dismissal."expiresAt"
         FROM vulnerability_dismissals AS dismissal
         JOIN vulnerabilities AS finding ON finding.id = dismissal."vulnerabilityId"
         JOIN assets AS asset ON asset.id = finding."assetId"
         JOIN targets AS target ON target.id = asset."targetId"
         WHERE dismissal.reason = 'risk_accepted' AND dismissal."expiresAt" <= $1
           AND ($3::timestamptz IS NULL OR (dismissal."expiresAt", dismissal.id) > ($3, $4::uuid))
         ORDER BY dismissal."expiresAt", dismissal.id
         LIMIT $2
       ), owners AS MATERIALIZED (
         SELECT workspace.id FROM workspaces AS workspace
         WHERE workspace.id IN (SELECT "workspaceId" FROM due)
         ORDER BY workspace.id
         FOR KEY SHARE OF workspace SKIP LOCKED
       ), locked AS MATERIALIZED (
         SELECT due.* FROM due
         JOIN owners ON owners.id = due."workspaceId"
         JOIN vulnerabilities AS finding ON finding.id = due."vulnerabilityId"
         ORDER BY finding.id
         FOR NO KEY UPDATE OF finding SKIP LOCKED
       ), locked_dismissals AS MATERIALIZED (
         SELECT dismissal.id, locked."workspaceId"
         FROM locked JOIN vulnerability_dismissals AS dismissal ON dismissal.id = locked.id
         WHERE dismissal.reason = 'risk_accepted' AND dismissal."expiresAt" <= $1
         ORDER BY dismissal.id
         FOR UPDATE OF dismissal SKIP LOCKED
       ), removed AS (
         DELETE FROM vulnerability_dismissals AS dismissal USING locked_dismissals
         WHERE dismissal.id = locked_dismissals.id
         RETURNING dismissal."vulnerabilityId", locked_dismissals."workspaceId",
                   dismissal."userId", dismissal.comment, dismissal."expiresAt"
       ), recorded AS (
         INSERT INTO vulnerability_events
           ("vulnerabilityId", "workspaceId", type, "occurredAt", data)
         SELECT "vulnerabilityId", "workspaceId", 'risk_expired', $1,
                jsonb_build_object('expiresAt', "expiresAt", 'acceptedById', "userId", 'comment', comment)
         FROM removed RETURNING id
       )
       SELECT (SELECT COUNT(*)::int FROM recorded) AS count,
              (SELECT COUNT(*)::int FROM due) AS examined,
              (SELECT jsonb_build_object('id', id, 'expiresAt', "expiresAt"::text)
               FROM due ORDER BY "expiresAt" DESC, id DESC LIMIT 1) AS next`,
      [now, BATCH_SIZE, after?.expiresAt ?? null, after?.id ?? null],
    );
    return result;
  }

  /** Move past locked rows for this sweep; the next sweep starts from the beginning. */
  async expireDue(now: Date): Promise<number> {
    let total = 0;
    let after: ExpiryCursor | null = null;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const page = await this.expireBatch(now, after);
      total += page.count;
      if (page.examined < BATCH_SIZE || !page.next) break;
      after = page.next;
    }
    return total;
  }

  /** Run once per hour across API replicas, with bounded work per sweep. */
  @Cron('5 * * * *')
  @Lock('cron:finding-risk-expiry', { ttl: 10 * 60_000 })
  async expireRiskAcceptances(): Promise<void> {
    const total = await this.expireDue(new Date());
    if (total) this.logger.log(`Expired ${total} risk acceptance(s)`);
  }
}
