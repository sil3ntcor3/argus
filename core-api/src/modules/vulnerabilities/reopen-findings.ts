import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** Remove only scoped dismissals, recording each reopen in the same transaction. */
export async function reopenFindings(
  manager: EntityManager,
  ids: string[],
  workspaceId: string,
  userId: string,
): Promise<void> {
  const unique = [...new Set(ids)];
  // Use the same parent-to-child lock order as dismissal and expiry.
  await manager.query('SELECT id FROM workspaces WHERE id = $1 FOR KEY SHARE', [
    workspaceId,
  ]);
  const [actor] = await manager.query<{ id: string }[]>(
    'SELECT id FROM users WHERE id = $1 FOR KEY SHARE',
    [userId],
  );
  await manager.query(
    `SELECT finding.id FROM vulnerability_dismissals AS dismissal
     JOIN vulnerabilities AS finding ON finding.id = dismissal."vulnerabilityId"
     JOIN assets AS asset ON asset.id = finding."assetId"
     JOIN targets AS target ON target.id = asset."targetId"
     WHERE target."workspaceId" = $2 AND dismissal.id = ANY($1::uuid[])
     ORDER BY finding.id FOR NO KEY UPDATE OF finding`,
    [unique, workspaceId],
  );
  // Read again after locking. A competing request may have already removed a row.
  const removed = await manager.query<{ id: string }[]>(
    `WITH removed AS (
       DELETE FROM vulnerability_dismissals AS dismissal
       USING vulnerabilities AS finding, assets AS asset, targets AS target
       WHERE finding.id = dismissal."vulnerabilityId" AND asset.id = finding."assetId"
         AND target.id = asset."targetId" AND target."workspaceId" = $2
         AND dismissal.id = ANY($1::uuid[])
       RETURNING dismissal.id, dismissal."vulnerabilityId", dismissal.reason,
                 dismissal."expiresAt", dismissal."userId", dismissal.comment
     ), classified AS (
       SELECT *, COALESCE(reason = 'risk_accepted' AND "expiresAt" <= statement_timestamp(), false) AS due
       FROM removed
     ), recorded AS (
       INSERT INTO vulnerability_events
         ("vulnerabilityId", "workspaceId", type, "actorId", "occurredAt", data)
       SELECT "vulnerabilityId", $2::uuid, CASE WHEN due THEN 'risk_expired' ELSE 'reopened' END,
              CASE WHEN due THEN NULL ELSE $3::uuid END, statement_timestamp(),
              CASE WHEN due THEN
                jsonb_build_object('expiresAt', "expiresAt", 'acceptedById', "userId", 'comment', comment)
              ELSE
                jsonb_build_object('previousReason', reason, 'expiresAt', "expiresAt")
              END
       FROM classified
     )
     SELECT id FROM removed`,
    [unique, workspaceId, actor?.id ?? null],
  );
  const found = new Set(removed.map(({ id }) => id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length)
    throw new NotFoundException(
      `Dismissed vulnerabilities not found: ${missing.join(', ')}`,
    );
}
