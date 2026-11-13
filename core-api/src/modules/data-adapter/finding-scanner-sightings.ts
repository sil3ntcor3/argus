import type { EntityManager } from 'typeorm';
import { FINDING_SCAN_WORKSPACE } from '../jobs-registry/finding-scan-evidence';
import { resolveVulnerabilitySettings, VULNERABILITY_SETTINGS_KEY } from '../vulnerabilities/vulnerability-settings';

/** Lock provenance parents before taking finding row locks, as deletion does. */
export async function lockFindingScannerSourceParents(
  manager: EntityManager,
  jobId: string,
): Promise<void> {
  await manager.query(
    `SELECT workspace.id
     FROM jobs AS job
     JOIN assets AS asset ON asset.id = job."assetId"
     JOIN targets AS target ON target.id = asset."targetId"
     JOIN workspaces AS workspace ON workspace.id = target."workspaceId"
     WHERE job.id = $1
     FOR KEY SHARE OF workspace`,
    [jobId],
  );
  await manager.query(
    `SELECT history.id
     FROM jobs AS job
     JOIN job_histories AS history ON history.id = job."jobHistoryId"
     JOIN tools AS tool ON tool.id = job."toolId"
     WHERE job.id = $1
     FOR KEY SHARE OF history, tool`,
    [jobId],
  );
}

/**
 * Record every positive under the upsert's finding locks. Only a distinct
 * run changes the detection count or status; repeat positives still advance
 * the database-clock cutoff for comparing future scans.
 */
export async function recordFindingScannerSightings(
  manager: EntityManager,
  jobId: string,
  findingIds: string[],
): Promise<void> {
  if (findingIds.length === 0) return;
  // The caller already holds the workspace KEY SHARE lock. Policy saves take
  // that parent FOR UPDATE before recomputing deadlines, so they serialize.
  const [workspace] = await manager.query<{ settings: unknown }[]>(
    `SELECT workspace.settings -> $2 AS settings FROM jobs job
     JOIN assets asset ON asset.id = job."assetId"
     JOIN targets target ON target.id = asset."targetId"
     JOIN workspaces workspace ON workspace.id = target."workspaceId"
     WHERE job.id = $1`, [jobId, VULNERABILITY_SETTINGS_KEY],
  );
  const policy = resolveVulnerabilitySettings(workspace?.settings);

  // Recover detections saved during a staged rollout from their stored date.
  // Only attach the run when it is the original run already locked above.
  await manager.query(
    `WITH report AS (
       SELECT finding.id AS "vulnerabilityId", job."toolId",
              history.id AS "jobHistoryId", history."projectId", target."workspaceId",
              finding."jobHistoryId" AS "firstRunId", finding."firstDetectedDate",
              CASE WHEN job."findingScanScopeKey" IS NOT NULL AND job.status = 'in_progress'
                   THEN job."findingScanClaimedAt" END AS "scanClaimedAt"
       FROM jobs AS job
       JOIN job_histories AS history ON history.id = job."jobHistoryId"
       LEFT JOIN workflows AS workflow ON workflow.id = history."workflowId"
       JOIN assets AS asset ON asset.id = job."assetId"
       JOIN targets AS target ON target.id = asset."targetId"
       JOIN vulnerabilities AS finding
         ON finding."assetId" = job."assetId" AND finding."toolId" = job."toolId"
       WHERE job.id = $1 AND finding.id = ANY($2::uuid[])
         AND ${FINDING_SCAN_WORKSPACE.replaceAll('scan.', 'job.')}
     ), detection AS (
       INSERT INTO vulnerability_events
         ("vulnerabilityId", "workspaceId", type, "toStatus", "jobHistoryId", "occurredAt")
       SELECT report."vulnerabilityId", report."workspaceId", 'detected', 'new',
              CASE WHEN report."firstRunId" = report."jobHistoryId" THEN report."jobHistoryId" END,
              report."firstDetectedDate"
       FROM report
       WHERE report."firstDetectedDate" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM vulnerability_events AS event
           WHERE event."vulnerabilityId" = report."vulnerabilityId" AND event.type = 'detected'
         )
     ), inserted AS (
       INSERT INTO vulnerability_sources ("vulnerabilityId", kind, "toolId", "jobHistoryId")
       SELECT "vulnerabilityId", 'tool', "toolId", "jobHistoryId" FROM report
       ORDER BY "vulnerabilityId"
       ON CONFLICT ("vulnerabilityId", kind, "jobHistoryId") DO NOTHING
       RETURNING "vulnerabilityId"
     ), fix_events AS (
       SELECT event."vulnerabilityId",
              CASE WHEN COUNT(*) = 1 THEN MAX(parsed.cutoff) END AS cutoff
       FROM vulnerability_events event
       JOIN report ON report."vulnerabilityId" = event."vulnerabilityId"
       JOIN vulnerabilities finding ON finding.id = event."vulnerabilityId"
       CROSS JOIN LATERAL (
         SELECT CASE WHEN jsonb_typeof(event.data->'scanClaimedAt') = 'string'
           AND event.data->>'scanClaimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
           AND pg_input_is_valid(event.data->>'scanClaimedAt', 'timestamp with time zone')
         THEN CASE WHEN isfinite((event.data->>'scanClaimedAt')::timestamptz)
             AND (event.data->>'scanClaimedAt')::timestamptz <= finding."fixedAt"
           THEN (event.data->>'scanClaimedAt')::timestamptz END END AS cutoff
       ) parsed
       WHERE event."workspaceId" = report."workspaceId"
         AND event.type = 'status_changed' AND event."toStatus" = 'fixed'
         AND event."occurredAt" = finding."fixedAt"
         AND event.data->>'reason' = 'not_detected_by_covering_scan'
         AND event.data->'coverageVersion' = '1'::jsonb
       GROUP BY event."vulnerabilityId"
     ), countable AS (
       SELECT report."vulnerabilityId", report."workspaceId", report."jobHistoryId",
              finding."detectionStatus" AS "fromStatus",
              NOT finding."isArchived" AND finding."detectionStatus" = 'fixed'
                AND report."scanClaimedAt" > COALESCE(fix_events.cutoff, finding."fixedAt") AS resurfaces
       FROM inserted JOIN report USING ("vulnerabilityId")
       JOIN vulnerabilities AS finding ON finding.id = inserted."vulnerabilityId"
       LEFT JOIN fix_events ON fix_events."vulnerabilityId" = finding.id
       WHERE report."firstRunId" IS DISTINCT FROM report."jobHistoryId"
         AND NOT EXISTS (
           SELECT 1
           FROM project_vulnerabilities AS prior
           JOIN projects AS project ON project.id = prior."projectId"
           WHERE prior."vulnerabilityId" = finding.id
             AND prior."projectId" = report."projectId"
             AND project."workspaceId" = report."workspaceId"
             AND (
               prior."firstSeenJobHistoryId" = report."jobHistoryId"
               OR prior."lastSeenJobHistoryId" = report."jobHistoryId"
               OR EXISTS (
                 SELECT 1 FROM project_vulnerability_observations AS observation
                 WHERE observation."projectVulnerabilityId" = prior.id
                   AND observation."jobHistoryId" = report."jobHistoryId"
               )
             )
         )
     ), counted AS (
       UPDATE vulnerabilities AS finding
       SET "lastScannerObservedAt" = GREATEST(finding."lastScannerObservedAt", statement_timestamp()),
           "lastSeenJobHistoryId" = COALESCE(reported."jobHistoryId", finding."lastSeenJobHistoryId"),
           "timesDetected" = finding."timesDetected" + CASE WHEN countable."vulnerabilityId" IS NULL THEN 0 ELSE 1 END,
           "detectionStatus" = CASE
             WHEN countable.resurfaces THEN 'resurfaced'
             WHEN NOT finding."isArchived" AND countable."fromStatus" IN ('new', 'resurfaced')
             THEN 'active' ELSE finding."detectionStatus"
           END,
           "fixedAt" = CASE WHEN countable.resurfaces THEN NULL ELSE finding."fixedAt" END,
           "fixedByJobHistoryId" = CASE WHEN countable.resurfaces THEN NULL ELSE finding."fixedByJobHistoryId" END,
           "fixClaimedAt" = CASE WHEN countable.resurfaces THEN NULL ELSE finding."fixClaimedAt" END,
           "fixClaimedById" = CASE WHEN countable.resurfaces THEN NULL ELSE finding."fixClaimedById" END,
           "dueAt" = CASE WHEN countable.resurfaces AND $4::boolean
             THEN statement_timestamp() + (($3::jsonb ->> finding.severity)::int * interval '1 day')
             ELSE COALESCE(finding."dueAt", COALESCE(finding."firstDetectedDate", finding."createdAt")
               + (($3::jsonb ->> finding.severity)::int * interval '1 day')) END,
           "resurfacedCount" = finding."resurfacedCount" + CASE WHEN countable.resurfaces THEN 1 ELSE 0 END,
           "missedScans" = CASE
             WHEN countable.resurfaces OR (NOT finding."isArchived"
               AND finding."detectionStatus" IN ('new', 'active', 'resurfaced'))
             THEN 0 ELSE finding."missedScans" END
       FROM unnest($2::uuid[]) AS observed("vulnerabilityId")
       LEFT JOIN countable USING ("vulnerabilityId")
       LEFT JOIN report AS reported USING ("vulnerabilityId")
       WHERE finding.id = observed."vulnerabilityId"
       RETURNING finding.id, countable."workspaceId", countable."jobHistoryId",
                 COALESCE(countable."fromStatus", finding."detectionStatus") AS "fromStatus",
                 finding."detectionStatus" AS "toStatus"
     )
     INSERT INTO vulnerability_events
       ("vulnerabilityId", "workspaceId", type, "fromStatus", "toStatus", "jobHistoryId", "occurredAt")
     SELECT id, "workspaceId", 'status_changed', "fromStatus", "toStatus", "jobHistoryId", statement_timestamp()
     FROM counted WHERE "fromStatus" <> "toStatus"`,
    [jobId, findingIds, JSON.stringify(policy.slaDays), policy.slaRestartOnResurface],
  );
}
