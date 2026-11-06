import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectScopeRule } from './entities/project-scope-rule.entity';
import { scopeRulesSql, SqlParams } from './scope-rules';

@Injectable()
export class ProjectScopeDiscoveryService {
  constructor(private readonly dataSource: DataSource) {}

  async addDiscoveredAssets(
    workspaceId: string,
    assetIds: string[],
  ): Promise<Map<string, string[]>> {
    const added = new Map<string, string[]>();
    if (assetIds.length === 0) return added;
    // Share the project row lock with scope replacement and manual membership
    // changes. Lock in a stable order, then read the current rules under it.
    // One transaction also makes a failed multi-project batch safe to retry.
    return this.dataSource.transaction(async (manager) => {
      const projects = await manager.query<{ id: string }[]>(
        `SELECT p.id FROM projects p
         WHERE p."workspaceId" = $1 AND p."autoAddAssets" AND p."archivedAt" IS NULL
           AND EXISTS (SELECT 1 FROM project_scope_rules r WHERE r."projectId" = p.id)
         ORDER BY p.id FOR UPDATE OF p`,
        [workspaceId],
      );
      for (const project of projects) {
        const rules = await manager.find(ProjectScopeRule, {
          where: { projectId: project.id },
          order: { createdAt: 'ASC', id: 'ASC' },
        });
        const params = new SqlParams([
          project.id,
          workspaceId,
          [...new Set(assetIds)],
        ]);
        const built = scopeRulesSql(rules, params);
        if (!built) continue;
        const rows = await manager.query<{ assetId: string }[]>(
          `INSERT INTO project_assets ("projectId", "assetId", source, "scopeRuleId")
           SELECT $1, a.id, 'rule', ${built.ruleIdSql()}
           FROM assets a JOIN targets t ON t.id = a."targetId"
           WHERE t."workspaceId" = $2 AND a.id = ANY($3::uuid[]) AND ${built.where}
           ON CONFLICT ("projectId", "assetId") DO NOTHING RETURNING "assetId"`,
          params.values,
        );
        if (rows.length)
          added.set(
            project.id,
            rows.map((row) => row.assetId),
          );
      }
      return added;
    });
  }
}
