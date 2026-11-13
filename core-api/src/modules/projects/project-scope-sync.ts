import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ProjectScopeRule } from './entities/project-scope-rule.entity';
import { scopeRulesSql, SqlParams } from './scope-rules';

export interface ScopeSyncResult {
  added: string[];
  removed: number;
}

/** All scope mutators must use this lock in their caller-owned transaction. */
export async function lockProjectScope(
  manager: EntityManager,
  projectId: string,
  workspaceId: string,
): Promise<string> {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new Error('Project scope sync requires an active transaction');
  }
  const [project] = await manager.query<{ id: string; archivedAt?: Date | null }[]>(
    `SELECT id, "archivedAt" FROM projects WHERE id = $1 AND "workspaceId" = $2 FOR UPDATE`,
    [projectId, workspaceId],
  );
  if (!project) throw new NotFoundException('Project not found');
  if (project.archivedAt) throw new BadRequestException('Project is archived');
  return project.id;
}

/** Internal preparation: no API, discovery or legacy mutation calls this yet. */
export async function syncProjectScope(
  manager: EntityManager,
  projectId: string,
  workspaceId: string,
): Promise<ScopeSyncResult> {
  const id = await lockProjectScope(manager, projectId, workspaceId);
  const rules = await manager.find(ProjectScopeRule, {
    where: { projectId: id },
    order: { createdAt: 'ASC', id: 'ASC' },
  });
  const params = new SqlParams([id, workspaceId]);
  const built = scopeRulesSql(rules, params);
  if (!built) {
    const removed = await manager.query<unknown[]>(
      `DELETE FROM project_assets WHERE "projectId" = $1 AND source = 'rule' RETURNING id`,
      [id],
    );
    return { added: [], removed: deletedCount(removed) };
  }
  const desired = `WITH desired AS MATERIALIZED (
    SELECT a.id AS "assetId", ${built.ruleIdSql()} AS "ruleId"
    FROM assets a JOIN targets t ON t.id = a."targetId"
    WHERE t."workspaceId" = $2 AND ${built.where})`;
  const removed = await manager.query<unknown[]>(
    `${desired} DELETE FROM project_assets pa
     WHERE pa."projectId" = $1 AND pa.source = 'rule'
       AND NOT EXISTS (SELECT 1 FROM desired d WHERE d."assetId" = pa."assetId")
     RETURNING pa.id`,
    params.values,
  );
  await manager.query(
    `${desired} UPDATE project_assets pa SET "scopeRuleId" = d."ruleId"
     FROM desired d WHERE pa."projectId" = $1 AND pa."assetId" = d."assetId"
       AND pa.source = 'rule' AND pa."scopeRuleId" IS DISTINCT FROM d."ruleId"`,
    params.values,
  );
  const added = await manager.query<{ assetId: string }[]>(
    `${desired} INSERT INTO project_assets ("projectId", "assetId", source, "scopeRuleId")
     SELECT $1, d."assetId", 'rule', d."ruleId" FROM desired d
     ON CONFLICT ("projectId", "assetId") DO NOTHING RETURNING "assetId"`,
    params.values,
  );
  return {
    added: added.map((row) => row.assetId),
    removed: deletedCount(removed),
  };
}

/** TypeORM PostgreSQL DELETE RETURNING yields [rows, count], unlike SELECT. */
function deletedCount(result: unknown[]): number {
  return Array.isArray(result[0]) ? result[0].length : result.length;
}
