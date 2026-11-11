import { EventTriggerType } from '@/common/enums/enum';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { openVulnerabilityCondition } from '../vulnerabilities/open-vulnerability';
import type { Job } from './entities/job.entity';

const COMPLETED_SCANS = `
  FROM jobs AS scan
  JOIN job_histories AS history ON history.id = scan."jobHistoryId"
  JOIN workflows AS workflow ON workflow.id = history."workflowId"
  JOIN assets AS asset ON asset.id = scan."assetId"
  JOIN targets AS target ON target.id = asset."targetId"
  WHERE target."workspaceId" = workflow."workspaceId"
    AND history."isCompleted" = true
    AND scan.category = 'vulnerabilities'
    AND scan.status = 'completed'
    AND scan."findingScanCoverageComplete" IS TRUE
    AND scan."findingScanScopeKey" ~ '^image-v1:[0-9a-f]{64}$'
    AND scan."findingScanClaimedAt" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM jobs AS unfinished
      WHERE unfinished."jobHistoryId" = history.id
        AND unfinished.status IN ('pending', 'in_progress', 'cancelled')
    )`;

const ELIGIBLE_FINDING = `
  finding."lastScannerObservedAt" IS NOT NULL
  AND finding."detectionStatus" IN ('new', 'active', 'resurfaced')
  AND ${openVulnerabilityCondition('finding')}`;

@Injectable()
export class FindingScanAccountingService {
  private readonly logger = new Logger(FindingScanAccountingService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Recompute the private count after a workflow commits. This is a cache,
   * not authority for closure: jobs can later be retried or removed.
   * Older tag-only evidence cannot prove a comparable miss.
   */
  @OnEvent(EventTriggerType.WORKFLOW_END)
  async onWorkflowEnd(job: Job): Promise<void> {
    const runId = job?.jobHistory?.id;
    if (!runId) return;

    try {
      await this.dataSource.transaction(async (manager) => {
        // Lock in the ingestion order. The next statement sees a positive
        // that committed while this transaction was waiting for its lock.
        const candidates = await manager.query<{ id: string }[]>(
          `WITH completed_scope AS (
             SELECT scan."assetId", scan."toolId", scan."findingScanScopeKey",
                    MAX(scan."findingScanClaimedAt") AS claimed_at
             ${COMPLETED_SCANS}
             AND scan."jobHistoryId" = $1
             GROUP BY scan."assetId", scan."toolId", scan."findingScanScopeKey"
           )
           SELECT finding.id
           FROM vulnerabilities AS finding
           JOIN completed_scope AS scope ON scope."assetId" = finding."assetId"
             AND scope."toolId" = finding."toolId"
             AND scope."findingScanScopeKey" = finding."scanScopeKey"
           WHERE ${ELIGIBLE_FINDING}
             AND scope.claimed_at > finding."lastScannerObservedAt"
           ORDER BY finding.fingerprint, finding.id
           FOR UPDATE OF finding`,
          [runId],
        );
        if (candidates.length === 0) return;

        await manager.query(
          `WITH candidates AS (
             SELECT finding.id, finding."assetId", finding."toolId",
                    finding."scanScopeKey", finding."lastScannerObservedAt"
             FROM vulnerabilities AS finding
             WHERE finding.id = ANY($1::uuid[]) AND ${ELIGIBLE_FINDING}
           ), scopes AS (
             SELECT "assetId", "toolId", "scanScopeKey",
                    MIN("lastScannerObservedAt") AS cutoff
             FROM candidates GROUP BY "assetId", "toolId", "scanScopeKey"
           ), covered_runs AS (
             SELECT scan."assetId", scan."toolId", scan."findingScanScopeKey",
                    scan."jobHistoryId", MAX(scan."findingScanClaimedAt") AS claimed_at
             ${COMPLETED_SCANS}
             AND EXISTS (
               SELECT 1 FROM scopes AS scope
               WHERE scope."assetId" = scan."assetId" AND scope."toolId" = scan."toolId"
                 AND scope."scanScopeKey" = scan."findingScanScopeKey"
                 AND scan."findingScanClaimedAt" > scope.cutoff
             )
             GROUP BY scan."assetId", scan."toolId", scan."findingScanScopeKey", scan."jobHistoryId"
           ), counts AS (
             SELECT finding.id, COUNT(covered."jobHistoryId")::int AS misses
             FROM candidates AS finding
             LEFT JOIN covered_runs AS covered ON covered."assetId" = finding."assetId"
               AND covered."toolId" = finding."toolId"
               AND covered."findingScanScopeKey" = finding."scanScopeKey"
               AND covered.claimed_at > finding."lastScannerObservedAt"
               AND NOT EXISTS (
                 SELECT 1 FROM vulnerability_sources AS seen
                 WHERE seen."vulnerabilityId" = finding.id AND seen.kind = 'tool'
                   AND seen."jobHistoryId" = covered."jobHistoryId"
               )
             GROUP BY finding.id
           )
           UPDATE vulnerabilities AS finding SET "missedScans" = counts.misses
           FROM counts WHERE finding.id = counts.id
             AND finding."missedScans" IS DISTINCT FROM counts.misses`,
          [candidates.map(({ id }) => id)],
        );
      });
    } catch {
      // A private counter must not undo workflow completion. A later covered
      // run recomputes from the durable evidence rather than a missed event.
      this.logger.warn(`Could not refresh finding misses for run ${runId}`);
    }
  }
}
