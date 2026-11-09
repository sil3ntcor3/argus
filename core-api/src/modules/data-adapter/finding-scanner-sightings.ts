import type { EntityManager } from 'typeorm';

/** Lock source parents before taking finding row locks, as run deletion does. */
export async function lockFindingScannerSourceParents(
  manager: EntityManager,
  jobId: string,
): Promise<void> {
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

/** Record scanner provenance and count each newly observed run in the upsert transaction. */
export async function recordFindingScannerSightings(
  manager: EntityManager,
  jobId: string,
  findingIds: string[],
): Promise<void> {
  if (findingIds.length === 0) return;

  await manager.query(
    `WITH report AS (
       SELECT finding.id AS "vulnerabilityId", job."toolId",
              history.id AS "jobHistoryId", history."projectId", target."workspaceId"
       FROM jobs AS job
       JOIN job_histories AS history ON history.id = job."jobHistoryId"
       JOIN workflows AS workflow ON workflow.id = history."workflowId"
       JOIN assets AS asset ON asset.id = job."assetId"
       JOIN targets AS target ON target.id = asset."targetId"
       JOIN vulnerabilities AS finding
         ON finding."assetId" = job."assetId" AND finding."toolId" = job."toolId"
       WHERE job.id = $1 AND finding.id = ANY($2::uuid[])
         AND workflow."workspaceId" = target."workspaceId"
     ), inserted AS (
       INSERT INTO vulnerability_sources ("vulnerabilityId", kind, "toolId", "jobHistoryId")
       SELECT "vulnerabilityId", 'tool', "toolId", "jobHistoryId" FROM report
       ORDER BY "vulnerabilityId"
       ON CONFLICT ("vulnerabilityId", kind, "jobHistoryId") DO NOTHING
       RETURNING "vulnerabilityId"
     )
     UPDATE vulnerabilities AS finding
     SET "timesDetected" = finding."timesDetected" + 1
     FROM inserted JOIN report USING ("vulnerabilityId")
     WHERE finding.id = inserted."vulnerabilityId"
       AND finding."jobHistoryId" IS DISTINCT FROM report."jobHistoryId"
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
       )`,
    [jobId, findingIds],
  );
}
