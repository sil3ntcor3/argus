import type { EntityManager } from 'typeorm';

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
       JOIN workflows AS workflow ON workflow.id = history."workflowId"
       JOIN assets AS asset ON asset.id = job."assetId"
       JOIN targets AS target ON target.id = asset."targetId"
       JOIN vulnerabilities AS finding
         ON finding."assetId" = job."assetId" AND finding."toolId" = job."toolId"
       WHERE job.id = $1 AND finding.id = ANY($2::uuid[])
         AND workflow."workspaceId" = target."workspaceId"
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
     ), countable AS (
       SELECT report."vulnerabilityId", report."workspaceId", report."jobHistoryId",
              finding."detectionStatus" AS "fromStatus",
              NOT finding."isArchived" AND finding."detectionStatus" = 'fixed'
                AND report."scanClaimedAt" > finding."fixedAt" AS resurfaces
       FROM inserted JOIN report USING ("vulnerabilityId")
       JOIN vulnerabilities AS finding ON finding.id = inserted."vulnerabilityId"
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
           "timesDetected" = finding."timesDetected" + CASE WHEN countable."vulnerabilityId" IS NULL THEN 0 ELSE 1 END,
           "detectionStatus" = CASE
             WHEN countable.resurfaces THEN 'resurfaced'
             WHEN NOT finding."isArchived" AND countable."fromStatus" IN ('new', 'resurfaced')
             THEN 'active' ELSE finding."detectionStatus"
           END,
           "fixedAt" = CASE WHEN countable.resurfaces THEN NULL ELSE finding."fixedAt" END,
           "resurfacedCount" = finding."resurfacedCount" + CASE WHEN countable.resurfaces THEN 1 ELSE 0 END,
           "missedScans" = CASE
             WHEN countable.resurfaces OR (NOT finding."isArchived"
               AND finding."detectionStatus" IN ('new', 'active', 'resurfaced'))
             THEN 0 ELSE finding."missedScans" END
       FROM unnest($2::uuid[]) AS observed("vulnerabilityId")
       LEFT JOIN countable USING ("vulnerabilityId")
       WHERE finding.id = observed."vulnerabilityId"
       RETURNING finding.id, countable."workspaceId", countable."jobHistoryId",
                 COALESCE(countable."fromStatus", finding."detectionStatus") AS "fromStatus",
                 finding."detectionStatus" AS "toStatus"
     )
     INSERT INTO vulnerability_events
       ("vulnerabilityId", "workspaceId", type, "fromStatus", "toStatus", "jobHistoryId", "occurredAt")
     SELECT id, "workspaceId", 'status_changed', "fromStatus", "toStatus", "jobHistoryId", statement_timestamp()
     FROM counted WHERE "fromStatus" <> "toStatus"`,
    [jobId, findingIds],
  );
}
