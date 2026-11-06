import { ProjectScopeRuleType as Kind } from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { ProjectScopeRule } from './entities/project-scope-rule.entity';
import { countScopeRules } from './project-scope-preview.service';
import type { ScopeRuleLike } from './scope-rules';

export interface ScopeRuleView extends ScopeRuleLike {
  id: string;
  label: string;
  matched: number;
}
export interface ProjectScopeView {
  rules: ScopeRuleView[];
  autoAddAssets: boolean;
  ruleAssets: number;
  manualAssets: number;
}

const labelKey = (type: string, value: string) =>
  `${type}:${value.toLowerCase()}`;

/** Internal read model; public scope-rule routes follow separately. */
@Injectable()
export class ProjectScopeReadService {
  constructor(private readonly dataSource: DataSource) {}

  async getScope(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectScopeView> {
    const [project] = await this.dataSource.query<
      { id: string; autoAddAssets: boolean }[]
    >(
      `SELECT id, "autoAddAssets" FROM projects WHERE id = $1 AND "workspaceId" = $2`,
      [projectId, workspaceId],
    );
    if (!project) throw new NotFoundException('Project not found');
    const rules = await this.dataSource.getRepository(ProjectScopeRule).find({
      where: { projectId: project.id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const [matched, labels, counts] = await Promise.all([
      countScopeRules(this.dataSource, workspaceId, rules),
      this.labels(workspaceId, rules),
      this.dataSource.query<{ source: string; count: number }[]>(
        `SELECT pa.source, COUNT(*)::int AS count FROM project_assets pa
         JOIN assets a ON a.id = pa."assetId" JOIN targets t ON t.id = a."targetId"
         WHERE pa."projectId" = $1 AND t."workspaceId" = $2 GROUP BY pa.source`,
        [project.id, workspaceId],
      ),
    ]);
    const count = (source: string) =>
      Number(counts.find((row) => row.source === source)?.count ?? 0);
    return {
      rules: rules.map((rule, i) => ({
        id: rule.id,
        mode: rule.mode,
        type: rule.type,
        value: rule.value,
        label: labels.get(labelKey(rule.type, rule.value)) ?? rule.value,
        matched: matched[i],
      })),
      autoAddAssets: project.autoAddAssets,
      ruleAssets: count('rule'),
      manualAssets: count('manual'),
    };
  }

  private async labels(
    workspaceId: string,
    rules: ScopeRuleLike[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rules
          .filter(
            (rule) =>
              (rule.type === Kind.TARGET || rule.type === Kind.ASSET) &&
              isUUID(rule.value),
          )
          .map((rule) => rule.value.toLowerCase()),
      ),
    ];
    if (!ids.length) return new Map();
    const rows = await this.dataSource.query<
      { type: string; id: string; value: string }[]
    >(
      `SELECT 'target' AS type, id::text AS id, value FROM targets
       WHERE "workspaceId" = $1 AND id = ANY($2::uuid[])
       UNION ALL
       SELECT 'asset' AS type, a.id::text AS id, a.value FROM assets a
       JOIN targets t ON t.id = a."targetId"
       WHERE t."workspaceId" = $1 AND a.id = ANY($2::uuid[])`,
      [workspaceId, ids],
    );
    return new Map(rows.map((row) => [labelKey(row.type, row.id), row.value]));
  }
}
