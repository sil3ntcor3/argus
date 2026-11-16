import { BOT_ID } from '@/common/constants/app.constants';
import type { EntityManager } from 'typeorm';
import type { ProvenIssueFact } from '../event-bridge/sinks/issues/issues.sink';
import { findingRunWorkspaceCondition } from '../vulnerabilities/vulnerability-run-access';
import { openVulnerabilityCondition } from '../vulnerabilities/open-vulnerability';

export interface IssueFindingProof { id: string; vulnerabilityId: string; admitted: boolean; eligible: boolean }

/** Retained run parents precede the same ordered finding locks as ingestion. */
export async function lockIssueFindingProofs(manager: EntityManager, fact: ProvenIssueFact, proofIds: string[]): Promise<void> {
  await manager.query(`SELECT history.id FROM job_histories history
    WHERE history.id IN (SELECT proof."jobHistoryId" FROM vulnerability_events proof
      JOIN vulnerabilities finding ON finding.id=proof."vulnerabilityId"
      JOIN assets asset ON asset.id=finding."assetId" JOIN targets target ON target.id=asset."targetId"
      WHERE proof.id=ANY($1::uuid[]) AND target."workspaceId"=$2 AND proof."workspaceId"=$2)
    ORDER BY history.id FOR KEY SHARE`, [proofIds, fact.workspaceId]);
  await manager.query(`SELECT finding.id FROM vulnerabilities finding
    JOIN assets asset ON asset.id=finding."assetId" JOIN targets target ON target.id=asset."targetId"
    WHERE target."workspaceId"=$1 AND (finding.id=ANY($2::uuid[]) OR EXISTS (
      SELECT 1 FROM issue_links linked JOIN issues issue ON issue.id=linked."issueId"
      WHERE issue."workspaceId"=$1 AND linked."resourceType"='vulnerability' AND linked."resourceId"=finding.id
        AND EXISTS (SELECT 1 FROM issue_links trigger_link WHERE trigger_link."issueId"=issue.id
          AND trigger_link."resourceType"='vulnerability' AND trigger_link."resourceId"=ANY($2::uuid[]))))
    ORDER BY finding.fingerprint,finding.id FOR NO KEY UPDATE OF finding`, [fact.workspaceId, fact.vulnerabilityIds]);
}

/** The transport identifies proof; only committed tenant-scoped records authorize work. */
export async function loadIssueFindingProofs(manager: EntityManager, fact: ProvenIssueFact, ids: string[]): Promise<IssueFindingProof[]> {
  const runOwned = `EXISTS (SELECT 1 FROM job_histories history LEFT JOIN workflows workflow ON workflow.id=history."workflowId"
    WHERE history.id=proof."jobHistoryId" AND ${findingRunWorkspaceCondition('history', 'workflow', '$1')})`;
  const scanner = `${runOwned} AND EXISTS (SELECT 1 FROM jobs job
    JOIN vulnerability_sources source ON source."jobHistoryId"=job."jobHistoryId"
    WHERE job.id=$4::uuid AND job."jobHistoryId"=proof."jobHistoryId" AND job."assetId"=finding."assetId"
      AND job."toolId"=finding."toolId" AND source.kind='tool' AND source."toolId"=job."toolId"
      AND source."vulnerabilityId"=finding.id)`;
  return manager.query<IssueFindingProof[]>(`WITH candidates AS (
    SELECT proof.*, CASE
        WHEN $3='vulnerability.detected' AND proof.type='approved' AND proof."fromStatus"='pending_review'
          AND proof."toStatus"='approved' AND proof."actorId"=$5::uuid THEN true
        WHEN $3='vulnerability.detected' AND proof.type='detected' AND proof."toStatus"='new'
          AND proof."occurredAt"<=finding."lastScannerObservedAt" AND ${scanner} THEN true
        WHEN $3='vulnerability.resurfaced' AND proof.type='status_changed'
          AND proof."fromStatus"='fixed' AND proof."toStatus"='resurfaced' AND ${scanner} THEN true
        WHEN $3='vulnerability.fixed' AND proof.type='status_changed' AND proof."toStatus"='fixed'
          AND proof.data->>'reason'='not_detected_by_covering_scan' AND proof.data->'coverageVersion'='1'::jsonb
          AND ($6::uuid IS NULL OR proof."jobHistoryId"=$6::uuid) AND ${runOwned} THEN true
        ELSE false END AS admitted,
      CASE WHEN $3='vulnerability.fixed' THEN finding."reviewStatus"='approved'
        AND finding."detectionStatus"='fixed' AND finding."fixedAt"=proof."occurredAt"
      ELSE ${openVulnerabilityCondition('finding')}
        AND NOT EXISTS (SELECT 1 FROM issue_links decided_link
          JOIN issues decided ON decided.id=decided_link."issueId" AND decided."workspaceId"=$1
          JOIN comments decision ON decision."issueId"=decided.id AND decision.type IN ('open','closed','system')
          WHERE decided_link."resourceType"='vulnerability' AND decided_link."resourceId"=finding.id
            AND decision."createdById" IS DISTINCT FROM '${BOT_ID}'::uuid
            AND (decision."createdAt" AT TIME ZONE 'UTC')>=proof."occurredAt")
        AND (proof.type<>'approved' OR (finding."reviewedById"=proof."actorId" AND finding."reviewedAt" IS NOT NULL AND finding."reviewedAt"<=proof."occurredAt"))
        AND ($3<>'vulnerability.resurfaced' OR NOT EXISTS (
          SELECT 1 FROM vulnerability_events later WHERE later."vulnerabilityId"=finding.id
            AND later."workspaceId"=$1 AND later."occurredAt">proof."occurredAt"
            AND later.type='status_changed' AND (later."fromStatus"='fixed' OR later."toStatus"='fixed')))
      END AS eligible
    FROM vulnerability_events proof JOIN vulnerabilities finding ON finding.id=proof."vulnerabilityId"
    JOIN assets asset ON asset.id=finding."assetId" JOIN targets target ON target.id=asset."targetId"
    WHERE proof.id=ANY($2::uuid[]) AND proof."workspaceId"=$1 AND target."workspaceId"=$1
      AND finding.id=ANY($7::uuid[]) AND proof."occurredAt"<=statement_timestamp()
    ) SELECT id,"vulnerabilityId",COALESCE(admitted,false) AS admitted,COALESCE(eligible,false) AS eligible FROM candidates`,
  [fact.workspaceId, ids, fact.event, 'jobId' in fact ? fact.jobId ?? null : null,
    fact.actorUserId ?? null, 'jobHistoryId' in fact ? fact.jobHistoryId ?? null : null, fact.vulnerabilityIds]);
}

/** Compare database timestamps directly; manual writes stamp UTC after acquiring locks. */
export const issueProofAfterManualCondition = (alias: string) => `EXISTS (
  SELECT 1 FROM vulnerability_events authority WHERE authority.id=:proofId
    AND authority."occurredAt">(${alias}."updatedAt" AT TIME ZONE 'UTC')
    AND NOT EXISTS (SELECT 1 FROM comments manual WHERE manual."issueId"=${alias}.id
      AND manual.type IN ('open','closed','system') AND manual."createdById" IS DISTINCT FROM :botId
      AND (manual."createdAt" AT TIME ZONE 'UTC')>=authority."occurredAt"))`;
