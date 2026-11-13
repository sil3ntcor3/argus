import { EventTriggerType } from '@/common/enums/enum';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import { EventBridgeService } from '../event-bridge/publishing/event-bridge.service';
import { resolveVulnerabilitySettings, VULNERABILITY_SETTINGS_KEY } from '../vulnerabilities/vulnerability-settings';
import type { Job } from './entities/job.entity';
import {
  COMPLETE_FINDING_SCAN, CURRENT_FINDING_SCOPE_JOIN, currentFindingScopes,
  ELIGIBLE_FINDING, FINDING_SCAN_FROM, NO_POSITIVE_SOURCE,
  FINDING_SCAN_WORKSPACE,
} from './finding-scan-evidence';

interface ClosedFinding {
  proofId: string;
  id: string;
  assetId: string;
  targetId: string;
  latestRun: string;
  latestJob: string;
}

@Injectable()
export class FindingScanAccountingService {
  private readonly logger = new Logger(FindingScanAccountingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventBridge: EventBridgeService,
  ) {}

  @OnEvent(EventTriggerType.WORKFLOW_END)
  async onWorkflowEnd(job: Job): Promise<void> {
    const runId = job?.jobHistory?.id;
    if (!runId) return;
    try {
      const result = await this.dataSource.transaction(async manager => {
        // Parent locks precede finding locks, as in positive ingestion/deletion.
        const [workspace] = await manager.query<{
          id: string; settings: Record<string, unknown>;
        }[]>(
          `SELECT workspace.id, workspace.settings ${FINDING_SCAN_FROM}
           JOIN workspaces workspace ON workspace.id = target."workspaceId"
           WHERE history.id = $1 AND ${FINDING_SCAN_WORKSPACE}
           ORDER BY workspace.id LIMIT 1 FOR KEY SHARE OF workspace`, [runId],
        );
        if (!workspace) return;
        const history = await manager.query<{ id: string }[]>(
          'SELECT id FROM job_histories WHERE id = $1 FOR KEY SHARE SKIP LOCKED', [runId],
        );
        if (!history.length) return;
        const policy = resolveVulnerabilitySettings(workspace.settings?.[VULNERABILITY_SETTINGS_KEY]);

        // Skip parents held by deletion/retention before taking finding locks.
        // A latest proof that changes to an unprotected parent is deferred.
        const parents = await manager.query<{ id: string }[]>(
          `WITH completed_scope AS (${currentFindingScopes('$1')})
           SELECT parent.id FROM job_histories parent WHERE parent.id IN (
             SELECT DISTINCT ON (finding.id) scan."jobHistoryId"
             ${FINDING_SCAN_FROM}
             JOIN vulnerabilities finding ON finding."assetId" = scan."assetId"
               AND finding."toolId" = scan."toolId"
               AND finding."scanScopeKey" = scan."findingScanScopeKey"
             ${CURRENT_FINDING_SCOPE_JOIN}
             WHERE ${COMPLETE_FINDING_SCAN} AND ${ELIGIBLE_FINDING}
               AND scope.claimed_at > finding."lastScannerObservedAt"
               AND scan."findingScanClaimedAt" > finding."lastScannerObservedAt"
               AND ${NO_POSITIVE_SOURCE}
             ORDER BY finding.id, scan."findingScanClaimedAt" DESC,
                      scan."jobHistoryId", scan.id
           ) ORDER BY parent.id FOR KEY SHARE OF parent SKIP LOCKED`, [runId],
        );
        const candidates = await manager.query<{ id: string }[]>(
          `WITH completed_scope AS (${currentFindingScopes('$1')})
           SELECT finding.id FROM vulnerabilities finding ${CURRENT_FINDING_SCOPE_JOIN}
           WHERE ${ELIGIBLE_FINDING}
             AND scope.claimed_at > finding."lastScannerObservedAt"
           ORDER BY finding.fingerprint, finding.id FOR UPDATE OF finding`, [runId],
        );
        if (!candidates.length) return;

        const closed = await manager.query<ClosedFinding[]>(
          `WITH completed_scope AS (${currentFindingScopes('$2')}), candidates AS (
             SELECT finding.id, finding."assetId", finding."toolId", finding."scanScopeKey",
                    finding."lastScannerObservedAt", finding."detectionStatus" AS "fromStatus"
             FROM vulnerabilities finding ${CURRENT_FINDING_SCOPE_JOIN}
             WHERE finding.id = ANY($1::uuid[]) AND ${ELIGIBLE_FINDING}
               AND scope.claimed_at > finding."lastScannerObservedAt"
           ), scopes AS (
             SELECT "assetId", "toolId", "scanScopeKey", MIN("lastScannerObservedAt") AS cutoff
             FROM candidates GROUP BY "assetId", "toolId", "scanScopeKey"
           ), covered_runs AS (
             SELECT DISTINCT ON (scan."assetId", scan."toolId", scan."findingScanScopeKey", scan."jobHistoryId")
                    scan."assetId", scan."toolId", scan."findingScanScopeKey",
                    scan."jobHistoryId", scan.id AS "jobId", scan."findingScanClaimedAt" AS claimed_at
             ${FINDING_SCAN_FROM} WHERE ${COMPLETE_FINDING_SCAN}
               AND EXISTS (SELECT 1 FROM scopes scope
                 WHERE scope."assetId" = scan."assetId" AND scope."toolId" = scan."toolId"
                   AND scope."scanScopeKey" = scan."findingScanScopeKey"
                   AND scan."findingScanClaimedAt" > scope.cutoff)
             ORDER BY scan."assetId", scan."toolId", scan."findingScanScopeKey", scan."jobHistoryId",
                      scan."findingScanClaimedAt" DESC, scan.id
           ), counts AS (
             SELECT finding.id, finding."fromStatus", COUNT(covered."jobHistoryId")::int AS misses,
                    MAX(covered.claimed_at) AS cutoff,
                    (ARRAY_AGG(covered."jobHistoryId" ORDER BY covered.claimed_at DESC,
                      covered."jobHistoryId", covered."jobId")
                      FILTER (WHERE covered."jobId" IS NOT NULL))[1] AS "latestRun",
                    (ARRAY_AGG(covered."jobId" ORDER BY covered.claimed_at DESC,
                      covered."jobHistoryId", covered."jobId")
                      FILTER (WHERE covered."jobId" IS NOT NULL))[1] AS "latestJob"
             FROM candidates finding
             LEFT JOIN covered_runs covered ON covered."assetId" = finding."assetId"
               AND covered."toolId" = finding."toolId"
               AND covered."findingScanScopeKey" = finding."scanScopeKey"
               AND covered.claimed_at > finding."lastScannerObservedAt"
               AND NOT EXISTS (SELECT 1 FROM vulnerability_sources seen
                 WHERE seen."vulnerabilityId" = finding.id AND seen.kind = 'tool'
                   AND seen."jobHistoryId" = covered."jobHistoryId")
             GROUP BY finding.id, finding."fromStatus"
           ), decisions AS (
             SELECT counts.*, COALESCE($4::boolean AND misses >= $5
               AND "latestRun" = ANY($3::uuid[]), false) AS closes FROM counts
           ), updated AS (
             UPDATE vulnerabilities finding SET "missedScans" = decisions.misses,
               "detectionStatus" = CASE WHEN decisions.closes THEN 'fixed' ELSE finding."detectionStatus" END,
               "fixedAt" = CASE WHEN decisions.closes THEN statement_timestamp() ELSE finding."fixedAt" END,
               "fixedByJobHistoryId" = CASE WHEN decisions.closes THEN decisions."latestRun" ELSE finding."fixedByJobHistoryId" END,
               "updatedAt" = CASE WHEN decisions.closes THEN statement_timestamp() ELSE finding."updatedAt" END
             FROM decisions WHERE finding.id = decisions.id
               AND (finding."missedScans" IS DISTINCT FROM decisions.misses OR decisions.closes)
             RETURNING finding.id, finding."assetId", finding."fixedAt", finding."fixClaimedAt",
                       decisions."fromStatus", decisions.misses, decisions.cutoff,
                       decisions."latestRun", decisions."latestJob", decisions.closes
           ), recorded AS (
             INSERT INTO vulnerability_events
               ("vulnerabilityId","workspaceId",type,"fromStatus","toStatus","jobHistoryId","occurredAt",data)
             SELECT updated.id, $6::uuid, 'status_changed', updated."fromStatus", 'fixed',
                    updated."latestRun", statement_timestamp(),
                    jsonb_build_object('reason','not_detected_by_covering_scan','coverageVersion',1,
                      'scanClaimedAt',updated.cutoff,'missedScans',updated.misses,
                      'fixClaimVerified',updated."fixClaimedAt" IS NOT NULL AND updated.cutoff > updated."fixClaimedAt")
             FROM updated WHERE updated.closes RETURNING id, "vulnerabilityId"
           ) SELECT updated.id, recorded.id AS "proofId", updated."assetId", target.id AS "targetId",
                    updated."latestRun", updated."latestJob"
             FROM updated JOIN recorded ON recorded."vulnerabilityId" = updated.id
             JOIN assets asset ON asset.id = updated."assetId"
             JOIN targets target ON target.id = asset."targetId"`,
          [candidates.map(value => value.id), runId, parents.map(value => value.id),
            policy.autoCloseEnabled, policy.autoCloseMissedScans, workspace.id],
        );
        return { workspaceId: workspace.id, closed };
      });
      if (!result?.closed.length) return;
      const groups = new Map<string, ClosedFinding[]>();
      for (const finding of result.closed) {
        const key = [finding.assetId, finding.latestRun, finding.latestJob].join(':');
        const rows = groups.get(key) ?? [];
        rows.push(finding);
        groups.set(key, rows);
      }
      for (const rows of groups.values()) await this.eventBridge.publishSafely(
        EVENT_CATALOG.vulnerability.fixed,
        { workspaceId: result.workspaceId, outcome: 'success', resourceType: 'vulnerability',
          metadata: { count: rows.length, findingEventIds: rows.map(value => value.proofId) }, payload: {
            vulnerabilityIds: rows.map(value => value.id), assetId: rows[0].assetId,
            targetId: rows[0].targetId, jobHistoryId: rows[0].latestRun, jobId: rows[0].latestJob,
          } },
      );
    } catch (error) {
      this.logger.warn(`Could not refresh finding coverage for run ${runId}: ${
        error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
