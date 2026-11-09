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
