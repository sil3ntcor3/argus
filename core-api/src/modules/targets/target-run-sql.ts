import { JobStatus } from '@/common/enums/enum';
import { JOB_HISTORY_STATUS_SQL } from '../jobs-registry/job-history-status';

/** Shared run membership for a workspace-scoped `owned` target CTE. */
export const TARGET_RUN_CTES = `
  target_assets AS MATERIALIZED (
    SELECT a.id FROM assets a JOIN owned t ON a."targetId" = t.id
  ), target_runs AS (
    SELECT h.id FROM owned t JOIN workflows w ON w."workspaceId" = t."workspaceId"
    JOIN job_histories h ON h."workflowId" = w.id
    WHERE h.scope -> 'targetIds' @> jsonb_build_array(t.id::text)
    UNION
    SELECT job."jobHistoryId" FROM jobs job JOIN target_assets a ON a.id = job."assetId"
    WHERE job."jobHistoryId" IS NOT NULL
  ), owned_runs AS (
    SELECT h.id, h."createdAt", h."updatedAt", h."jobRunType",
           h."isCompleted", w.name AS "workflowName"
    FROM target_runs r JOIN job_histories h ON h.id = r.id
    JOIN workflows w ON w.id = h."workflowId"
    JOIN owned t ON w."workspaceId" = t."workspaceId"
  )`;

export const TARGET_RUN_ORDER_SQL = '"createdAt" DESC, id DESC';

/** Public run fields from an owned run aliased as h. */
export const TARGET_RUN_FIELDS_SQL =
  'h.id, h."createdAt", h."updatedAt", h."isCompleted", h."jobRunType", h."workflowName"';

/** Skips the whole-run status rollup for old or finished runs aliased as h. */
export const TARGET_ACTIVE_RUN_CONDITION_SQL = `CASE
  WHEN h."isCompleted" IS DISTINCT FROM FALSE
    OR h."createdAt" <= LOCALTIMESTAMP - INTERVAL '7 days' THEN false
  ELSE (SELECT ${JOB_HISTORY_STATUS_SQL}
          FROM jobs job WHERE job."jobHistoryId" = h.id)
       IN ('${JobStatus.PENDING}', '${JobStatus.IN_PROGRESS}')
END`;

/** Whole-run status for a selected run aliased as p. */
export const TARGET_RUN_STATUS_SQL = `(SELECT ${JOB_HISTORY_STATUS_SQL}
  FROM jobs job WHERE job."jobHistoryId" = p.id)`;

/** Resolves the project only for a selected run and authorized workspace. */
export const TARGET_RUN_PROJECT_SQL = `
  SELECT project.id AS "projectId", project.name AS "projectName"
  FROM owned t JOIN job_histories h ON h.id = p.id
  JOIN projects project ON project.id = h."projectId" AND project."workspaceId" = t."workspaceId"
  WHERE t."canReadProjects"`;

/** Job progress and first-attributed findings on the selected target. */
export const TARGET_RUN_PROGRESS_SQL = `
  SELECT COUNT(*)::int AS "jobsTotal",
         COUNT(*) FILTER (WHERE job.status IN ('${JobStatus.COMPLETED}', '${JobStatus.SKIPPED}'))::int AS "jobsDone",
         COUNT(*) FILTER (WHERE job.status = '${JobStatus.FAILED}')::int AS "jobsFailed",
         COUNT(*) FILTER (WHERE job.status = '${JobStatus.IN_PROGRESS}')::int AS "jobsRunning",
         (SELECT tool.name FROM tools tool WHERE tool.id = (
           SELECT running."toolId"
           FROM jobs running JOIN target_assets a ON a.id = running."assetId"
           WHERE running."jobHistoryId" = p.id AND running.status = '${JobStatus.IN_PROGRESS}'
           ORDER BY running."pickJobAt" DESC NULLS LAST, running.id DESC LIMIT 1
         )) AS "currentTool",
         CASE WHEN (SELECT "canReadFindings" FROM owned) THEN (
           SELECT COUNT(*)::int
           FROM vulnerabilities v JOIN target_assets a ON a.id = v."assetId"
           WHERE v."jobHistoryId" = p.id AND v."reviewStatus"='approved'
         ) END AS "newVulnerabilities"
  FROM jobs job JOIN target_assets a ON a.id = job."assetId"
  WHERE job."jobHistoryId" = p.id`;
