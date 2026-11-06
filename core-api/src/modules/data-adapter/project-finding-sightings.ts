import type { EntityManager } from 'typeorm';

// Private identity must come from the saved job, never a callback's run object.
const reportScope = `
  SELECT project.id AS "projectId", finding.id AS "vulnerabilityId",
         history.id AS "jobHistoryId"
  FROM jobs AS source
  JOIN job_histories AS history ON history.id = source."jobHistoryId"
  JOIN projects AS project ON project.id = history."projectId"
  JOIN workflows AS workflow ON workflow.id = history."workflowId"
  JOIN assets AS asset ON asset.id = source."assetId"
  JOIN targets AS target ON target.id = asset."targetId"
  JOIN vulnerabilities AS finding
    ON finding."assetId" = source."assetId" AND finding."toolId" = source."toolId"
  WHERE source.id = $1 AND finding.id = ANY($2::uuid[])
    AND project."workspaceId" = workflow."workspaceId"
    AND project."workspaceId" = target."workspaceId"`;

/** Called inside the finding upsert transaction, after its ordered row locks. */
export async function recordProjectFindingSightings(
  manager: EntityManager,
  jobId: string,
  findingIds: string[],
): Promise<void> {
  if (findingIds.length === 0) return;
  const parameters = [jobId, findingIds];
  // A new link starts at zero until its first observation is recorded in this
  // transaction. Separate statements let the aggregate UPDATE see new links.
  await manager.query(
    `INSERT INTO project_vulnerabilities (
       "projectId", "vulnerabilityId", "firstSeenJobHistoryId",
       "lastSeenJobHistoryId", "firstSeenAt", "lastSeenAt", "timesSeen"
     )
     SELECT report."projectId", report."vulnerabilityId", report."jobHistoryId",
            report."jobHistoryId", now(), now(), 0
     FROM (${reportScope}) AS report
     ORDER BY report."vulnerabilityId"
     ON CONFLICT ("projectId", "vulnerabilityId") DO NOTHING`,
    parameters,
  );
  // Preserve both known legacy pointers before a new sighting can replace last.
  // New zero-count links must reach the counted observation INSERT below.
  await manager.query(
    `INSERT INTO project_vulnerability_observations
       ("projectVulnerabilityId", "jobHistoryId", "seenAt")
     SELECT link.id, history.id, MIN(known."seenAt")
     FROM (${reportScope}) AS report
     JOIN project_vulnerabilities AS link
       ON link."projectId" = report."projectId"
      AND link."vulnerabilityId" = report."vulnerabilityId"
     CROSS JOIN LATERAL (
       VALUES (link."firstSeenJobHistoryId", link."firstSeenAt"),
              (link."lastSeenJobHistoryId", link."lastSeenAt")
     ) AS known("jobHistoryId", "seenAt")
     JOIN job_histories AS history ON history.id = known."jobHistoryId"
     JOIN workflows AS workflow ON workflow.id = history."workflowId"
     JOIN projects AS project ON project.id = link."projectId"
     WHERE link."timesSeen" > 0 AND history."projectId" = project.id
       AND workflow."workspaceId" = project."workspaceId"
     GROUP BY link.id, history.id
     ORDER BY link.id, history.id
     ON CONFLICT ("projectVulnerabilityId", "jobHistoryId") DO NOTHING`,
    parameters,
  );
  await manager.query(
    `WITH observed AS (
       INSERT INTO project_vulnerability_observations
         ("projectVulnerabilityId", "jobHistoryId", "seenAt")
       SELECT link.id, report."jobHistoryId",
         CASE
           WHEN link."firstSeenJobHistoryId" = report."jobHistoryId" THEN link."firstSeenAt"
           WHEN link."lastSeenJobHistoryId" = report."jobHistoryId" THEN link."lastSeenAt"
           ELSE statement_timestamp()
         END
       FROM (${reportScope}) AS report
       JOIN project_vulnerabilities AS link
         ON link."projectId" = report."projectId"
        AND link."vulnerabilityId" = report."vulnerabilityId"
       ORDER BY link.id
       ON CONFLICT ("projectVulnerabilityId", "jobHistoryId") DO NOTHING
       RETURNING "projectVulnerabilityId", "jobHistoryId", "seenAt"
     )
     UPDATE project_vulnerabilities AS link
     SET "timesSeen" = link."timesSeen" + 1,
         "firstSeenJobHistoryId" = CASE
           WHEN link."timesSeen" = 0 OR observed."seenAt" < link."firstSeenAt"
           THEN observed."jobHistoryId" ELSE link."firstSeenJobHistoryId" END,
         "firstSeenAt" = CASE WHEN link."timesSeen" = 0
           THEN observed."seenAt" ELSE LEAST(link."firstSeenAt", observed."seenAt") END,
         "lastSeenJobHistoryId" = CASE
           WHEN link."timesSeen" = 0 OR observed."seenAt" > link."lastSeenAt"
           THEN observed."jobHistoryId" ELSE link."lastSeenJobHistoryId" END,
         "lastSeenAt" = CASE WHEN link."timesSeen" = 0
           THEN observed."seenAt" ELSE GREATEST(link."lastSeenAt", observed."seenAt") END,
         "updatedAt" = now()
     FROM observed WHERE link.id = observed."projectVulnerabilityId"`,
    parameters,
  );
}
