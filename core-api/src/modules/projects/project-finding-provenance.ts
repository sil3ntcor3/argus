import { JobStatus, ToolCategory } from '@/common/enums/enum';

export enum ProjectFindingProvenance {
  NEW = 'new',
  RECURRING = 'recurring',
  NOT_SEEN = 'not_seen',
}

/** Reference scan and last reporting run for an owned `pv`/`v` finding row. */
export const PROJECT_FINDING_REFERENCE_JOINS = `
LEFT JOIN LATERAL (
  SELECT h.id, h."createdAt"
  FROM jobs job
  JOIN job_histories h ON h.id = job."jobHistoryId"
  JOIN workflows w ON w.id = h."workflowId"
  JOIN projects p ON p.id = h."projectId" AND p."workspaceId" = w."workspaceId"
  JOIN assets a ON a.id = job."assetId"
  JOIN targets t ON t.id = a."targetId" AND t."workspaceId" = p."workspaceId"
  WHERE h."projectId" = pv."projectId"
    AND job."assetId" = v."assetId" AND job."toolId" = v."toolId"
    AND job.status = '${JobStatus.COMPLETED}'
    AND job.category = '${ToolCategory.VULNERABILITIES}'
  ORDER BY h."createdAt" DESC, h.id DESC
  LIMIT 1
) ref ON true
LEFT JOIN LATERAL (
  SELECT h."createdAt"
  FROM job_histories h
  JOIN workflows w ON w.id = h."workflowId"
  JOIN projects p ON p.id = h."projectId" AND p."workspaceId" = w."workspaceId"
  WHERE h.id = pv."lastSeenJobHistoryId" AND h."projectId" = pv."projectId"
) seen_run ON true`;

/** Classify only a later eligible scan with no recorded sighting as missed. */
export const PROJECT_FINDING_PROVENANCE_SQL = `CASE
  WHEN ref.id IS NOT NULL
   AND ref.id IS DISTINCT FROM pv."firstSeenJobHistoryId"
   AND ref.id IS DISTINCT FROM pv."lastSeenJobHistoryId"
   AND ref."createdAt" > COALESCE(seen_run."createdAt", pv."lastSeenAt" AT TIME ZONE 'UTC')
   AND NOT EXISTS (
     SELECT 1 FROM project_vulnerability_observations observed
     WHERE observed."projectVulnerabilityId" = pv.id AND observed."jobHistoryId" = ref.id
   ) THEN '${ProjectFindingProvenance.NOT_SEEN}'
  WHEN pv."timesSeen" <= 1 THEN '${ProjectFindingProvenance.NEW}'
  ELSE '${ProjectFindingProvenance.RECURRING}'
END`;
