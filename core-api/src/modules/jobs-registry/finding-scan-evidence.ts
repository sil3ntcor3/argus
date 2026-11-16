import { openVulnerabilityCondition } from '../vulnerabilities/open-vulnerability';
import { SAVED_TEMPLATE_SELECTION } from './saved-template-dispatch';

// Workflow-free saved-template runs must prove every job belongs to this one
// workspace. A deleted workflow or an orphan asset is insufficient evidence.
export const FINDING_SCAN_WORKSPACE = `(target."workspaceId" = workflow."workspaceId" OR (
  history."workflowId" IS NULL AND scan.inputs ? '${SAVED_TEMPLATE_SELECTION}'
  AND NOT EXISTS (
    SELECT 1 FROM jobs member
    LEFT JOIN assets member_asset ON member_asset.id = member."assetId"
    LEFT JOIN targets member_target ON member_target.id = member_asset."targetId"
    WHERE member."jobHistoryId" = history.id AND (
      member_target."workspaceId" IS DISTINCT FROM target."workspaceId"
      OR NOT COALESCE(member.inputs ? '${SAVED_TEMPLATE_SELECTION}', false)
    )
  )
))`;

export const FINDING_SCAN_FROM = `
  FROM jobs AS scan
  JOIN job_histories AS history ON history.id = scan."jobHistoryId"
  LEFT JOIN workflows AS workflow ON workflow.id = history."workflowId"
  JOIN assets AS asset ON asset.id = scan."assetId"
  JOIN targets AS target ON target.id = asset."targetId"`;

export const COMPLETE_FINDING_SCAN = `
  ${FINDING_SCAN_WORKSPACE}
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

export const ELIGIBLE_FINDING = `
  finding."lastScannerObservedAt" IS NOT NULL
  AND finding."detectionStatus" IN ('new', 'active', 'resurfaced')
  AND ${openVulnerabilityCondition('finding')}`;

export const currentFindingScopes = (runParameter: string) => `
  SELECT scan."assetId", scan."toolId", scan."findingScanScopeKey",
         MAX(scan."findingScanClaimedAt") AS claimed_at
  ${FINDING_SCAN_FROM} WHERE ${COMPLETE_FINDING_SCAN}
    AND scan."jobHistoryId" = ${runParameter}
  GROUP BY scan."assetId", scan."toolId", scan."findingScanScopeKey"`;

export const CURRENT_FINDING_SCOPE_JOIN = `
  JOIN completed_scope AS scope ON scope."assetId" = finding."assetId"
    AND scope."toolId" = finding."toolId"
    AND scope."findingScanScopeKey" = finding."scanScopeKey"`;

export const NO_POSITIVE_SOURCE = `NOT EXISTS (
  SELECT 1 FROM vulnerability_sources AS seen
  WHERE seen."vulnerabilityId" = finding.id AND seen.kind = 'tool'
    AND seen."jobHistoryId" = scan."jobHistoryId"
)`;
