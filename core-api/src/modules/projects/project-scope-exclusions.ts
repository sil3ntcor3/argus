import { ProjectScopeRuleType } from '@/common/enums/enum';
import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ProjectScopeRule } from './entities/project-scope-rule.entity';
import { lockProjectScope } from './project-scope-sync';
import {
  normalizeScopeRuleValue,
  scopeRulesSql,
  SqlParams,
} from './scope-rules';

/** Prepare durable removal exclusions in the caller's membership transaction. */
export async function excludeMatchedScopeAssets(
  manager: EntityManager,
  projectId: string,
  workspaceId: string,
  assetIds: string[],
): Promise<number> {
  const id = await lockProjectScope(manager, projectId, workspaceId);
  if (!Array.isArray(assetIds))
    throw new BadRequestException('Expected asset IDs');
  let ids: string[];
  try {
    ids = [
      ...new Set(
        assetIds.map((value) =>
          normalizeScopeRuleValue(ProjectScopeRuleType.ASSET, value),
        ),
      ),
    ];
  } catch {
    throw new BadRequestException('Expected valid asset UUIDs');
  }
  if (!ids.length) return 0;
  const rules = await manager.find(ProjectScopeRule, {
    where: { projectId: id },
    order: { createdAt: 'ASC', id: 'ASC' },
  });
  const params = new SqlParams([id, workspaceId, ids]);
  const built = scopeRulesSql(rules, params);
  if (!built) return 0;
  const added = await manager.query<{ id: string }[]>(
    `INSERT INTO project_scope_rules ("projectId", mode, type, value)
     SELECT $1, 'exclude', 'asset', a.id::text
     FROM assets a JOIN targets t ON t.id = a."targetId"
     WHERE t."workspaceId" = $2 AND a.id = ANY($3::uuid[]) AND ${built.where}
     RETURNING id`,
    params.values,
  );
  return added.length;
}
