import { JobStatus, ToolCategory } from '@/common/enums/enum';

export enum ProjectFindingProvenance {
  NEW = 'new',
  RECURRING = 'recurring',
  NOT_SEEN = 'not_seen',
}

/** Only scans that could persist findings are evidence of a miss. */
export const projectFindingSavedScanCondition = (alias: 'job' | 'j') => `
  ${alias}.status = '${JobStatus.COMPLETED}'
  AND ${alias}.category = '${ToolCategory.VULNERABILITIES}'
  AND ${alias}."isSaveData" = true`;

/** Reference scan for an owned asset and tool. Inputs are internal SQL expressions. */
export const projectFindingReferenceRunJoin = (
  projectId: string,
  assetId: string,
  toolId: string,
) => `
LEFT JOIN LATERAL (
  SELECT h.id, h."createdAt"
  FROM jobs job
  JOIN job_histories h ON h.id = job."jobHistoryId"
  JOIN workflows w ON w.id = h."workflowId"
  JOIN projects p ON p.id = h."projectId" AND p."workspaceId" = w."workspaceId"
  JOIN assets a ON a.id = job."assetId"
  JOIN targets t ON t.id = a."targetId" AND t."workspaceId" = p."workspaceId"
  WHERE h."projectId" = ${projectId}
    AND job."assetId" = ${assetId} AND job."toolId" = ${toolId}
    AND ${projectFindingSavedScanCondition('job')}
  ORDER BY h."createdAt" DESC, h.id DESC
  LIMIT 1
) ref ON true`;

const PROJECT_FINDING_LAST_SEEN_JOIN = `
LEFT JOIN LATERAL (
  SELECT h.id, h."createdAt"
  FROM job_histories h
  JOIN workflows w ON w.id = h."workflowId"
  JOIN projects p ON p.id = h."projectId" AND p."workspaceId" = w."workspaceId"
  WHERE h.id = pv."lastSeenJobHistoryId" AND h."projectId" = pv."projectId"
) seen_run ON true`;

/** Reference scan and last reporting run for an owned `pv`/`v` finding row. */
export const PROJECT_FINDING_REFERENCE_JOINS = `
${projectFindingReferenceRunJoin('pv."projectId"', 'v."assetId"', 'v."toolId"')}
${PROJECT_FINDING_LAST_SEEN_JOIN}`;

/** Classify only a later eligible scan with no recorded sighting as missed. */
export const PROJECT_FINDING_PROVENANCE_SQL = `CASE
  WHEN ref.id IS NOT NULL
   AND ref.id IS DISTINCT FROM pv."firstSeenJobHistoryId"
   AND ref.id IS DISTINCT FROM pv."lastSeenJobHistoryId"
   AND ref."createdAt" > COALESCE(seen_run."createdAt", pv."lastSeenAt" AT TIME ZONE 'UTC')
   AND NOT EXISTS (
     SELECT 1 FROM job_histories h
     JOIN workflows w ON w.id = h."workflowId"
     JOIN projects p ON p.id = h."projectId" AND p."workspaceId" = w."workspaceId"
     WHERE h."projectId" = pv."projectId" AND h."createdAt" >= ref."createdAt"
       AND (h.id = pv."firstSeenJobHistoryId" OR EXISTS (
         SELECT 1 FROM project_vulnerability_observations observed
         WHERE observed."projectVulnerabilityId" = pv.id AND observed."jobHistoryId" = h.id
       ))
   ) THEN '${ProjectFindingProvenance.NOT_SEEN}'
  WHEN pv."timesSeen" <= 1 THEN '${ProjectFindingProvenance.NEW}'
  ELSE '${ProjectFindingProvenance.RECURRING}'
END`;
