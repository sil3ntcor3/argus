import { BadRequestException, NotFoundException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import type { EntityManager } from 'typeorm';
import { VulnerabilityDismissal } from './entities/vulnerability-dismissal.entity';
import {
  RISK_ACCEPTED,
  type FindingDismissalReason,
} from './finding-dismissal-reason';
import { activeDismissalCondition } from './open-vulnerability';
import { loadVulnerabilitySettings } from './vulnerability-settings';

export type FindingDismissalInput = {
  reason: FindingDismissalReason;
  comment?: string;
  expiresAt?: string;
};

function parseExpiry({ reason, expiresAt }: FindingDismissalInput) {
  if (reason !== RISK_ACCEPTED) {
    if (expiresAt !== undefined)
      throw new BadRequestException('expiresAt only applies to risk_accepted');
    return undefined;
  }
  if (
    !expiresAt ||
    !isISO8601(expiresAt, { strict: true, strictSeparator: true }) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt)
  ) {
    throw new BadRequestException(
      'Risk acceptance requires an ISO 8601 expiresAt with a timezone',
    );
  }
  return new Date(expiresAt);
}

function checkExpiryWindow(expiresAt: Date | undefined, maxDays: number) {
  if (!expiresAt) return;
  const remaining = expiresAt.getTime() - Date.now();
  if (
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    remaining > maxDays * 86_400_000
  ) {
    throw new BadRequestException(
      `expiresAt must be in the future and at most ${maxDays} days away`,
    );
  }
}

/** Lock, replace and write dismissals in the caller's transaction. */
export async function dismissFindings(
  manager: EntityManager,
  ids: string[],
  workspaceId: string,
  userId: string,
  input: FindingDismissalInput,
) {
  const expiresAt = parseExpiry(input);
  const unique = [...new Set(ids)];
  // Follow the expiry sweep's parent-to-child lock order.
  await manager.query('SELECT id FROM workspaces WHERE id = $1 FOR KEY SHARE', [
    workspaceId,
  ]);
  const maxDays = expiresAt
    ? (await loadVulnerabilitySettings(manager, workspaceId)).riskAcceptMaxDays
    : 180;
  checkExpiryWindow(expiresAt, maxDays);
  const scoped = await manager.query<{ id: string }[]>(
    `SELECT finding.id FROM vulnerabilities AS finding
     JOIN assets AS asset ON asset.id = finding."assetId"
     JOIN targets AS target ON target.id = asset."targetId"
     WHERE target."workspaceId" = $2 AND finding.id = ANY($1::uuid[]) AND finding."reviewStatus"='approved'
     ORDER BY finding.fingerprint, finding.id FOR NO KEY UPDATE OF finding`,
    [unique, workspaceId],
  );
  const found = new Set(scoped.map(({ id }) => id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length)
    throw new NotFoundException(
      `Vulnerabilities not found: ${missing.join(', ')}`,
    );

  const existing = await manager.query<
    { id: string; vulnerabilityId: string; active: boolean }[]
  >(
    `SELECT d.id, d."vulnerabilityId", ${activeDismissalCondition('d')} AS active
     FROM vulnerability_dismissals d WHERE d."vulnerabilityId" = ANY($1::uuid[])`,
    [unique],
  );
  const alreadyDismissed = existing
    .filter(({ active }) => active)
    .map(({ vulnerabilityId }) => vulnerabilityId);
  if (alreadyDismissed.length) {
    throw new BadRequestException(
      `Vulnerabilities already dismissed: ${alreadyDismissed.join(', ')}`,
    );
  }
  if (existing.length) {
    const [removed] = await manager.query<{ count: number }[]>(
      `WITH locked AS MATERIALIZED (
         SELECT d.id FROM vulnerability_dismissals d
         WHERE d.id = ANY($1::uuid[]) AND NOT ${activeDismissalCondition('d')}
         ORDER BY d.id FOR UPDATE OF d SKIP LOCKED
       ), expired AS (
         DELETE FROM vulnerability_dismissals d USING locked WHERE d.id = locked.id
         RETURNING d."vulnerabilityId", d."userId", d.comment, d."expiresAt"
       ), recorded AS (
         INSERT INTO vulnerability_events ("vulnerabilityId", "workspaceId", type, "occurredAt", data)
         SELECT "vulnerabilityId", $2::uuid, 'risk_expired', statement_timestamp(),
                jsonb_build_object('expiresAt', "expiresAt", 'acceptedById', "userId", 'comment', comment)
         FROM expired RETURNING id
       ) SELECT COUNT(*)::int AS count FROM recorded`,
      [existing.map(({ id }) => id), workspaceId],
    );
    if (removed.count !== existing.length)
      throw new BadRequestException('Dismissals changed; retry the request');
  }

  checkExpiryWindow(expiresAt, maxDays);
  const repository = manager.getRepository(VulnerabilityDismissal);
  const dismissals = unique.map((vulnerabilityId) =>
    repository.create({
      vulnerabilityId,
      userId,
      reason: input.reason,
      comment: input.comment,
      ...(expiresAt ? { expiresAt } : {}),
    }),
  );
  await repository.save(dismissals);
  // Use the statement time so a replacement is recorded after its expiry event.
  await manager.query(
    `INSERT INTO vulnerability_events
       ("vulnerabilityId", "workspaceId", type, "actorId", "occurredAt", data)
     SELECT "vulnerabilityId", $2::uuid, 'dismissed', "userId", statement_timestamp(),
            jsonb_build_object('reason', reason, 'comment', comment, 'expiresAt', $3::text)
     FROM vulnerability_dismissals WHERE id = ANY($1::uuid[])`,
    [dismissals.map(({ id }) => id), workspaceId, expiresAt?.toISOString() ?? null],
  );
  return dismissals.map(
    ({
      id,
      vulnerabilityId,
      userId,
      reason,
      comment,
      createdAt,
      updatedAt,
    }) => ({
      id,
      vulnerabilityId,
      userId,
      reason,
      comment,
      createdAt,
      updatedAt,
      ...(expiresAt ? { expiresAt } : {}),
    }),
  );
}
