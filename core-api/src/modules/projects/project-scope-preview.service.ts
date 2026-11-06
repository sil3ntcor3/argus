import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ProjectScopeNormalizer,
  type ScopeRuleInput,
} from './project-scope-normalizer.service';
import {
  normalizeScopeRuleValue,
  scopeRuleMatchSql,
  scopeRulesSql,
  SqlParams,
  type ScopeRuleLike,
} from './scope-rules';

export interface ScopePreviewResult {
  ruleAssets: number;
  total: number;
  perRule: number[];
}

/** Includes count matches; exclusions count the include matches they remove. */
export async function countScopeRules(
  dataSource: Pick<DataSource, 'query'>,
  workspaceId: string,
  rules: ScopeRuleLike[],
): Promise<number[]> {
  const includes = rules.filter((rule) => rule.mode === Mode.INCLUDE);
  const assetExcludes = rules.filter(
    (rule) => rule.mode === Mode.EXCLUDE && rule.type === Kind.ASSET,
  );
  let matchedAssets: Set<string> | undefined;
  if (includes.length && assetExcludes.length > 1) {
    const ids = [
      ...new Set(assetExcludes.map((rule) => rule.value.toLowerCase())),
    ];
    const params = new SqlParams([workspaceId, ids]);
    const rows = await dataSource.query<{ id: string }[]>(
      `SELECT a.id::text AS id FROM assets a JOIN targets t ON t.id = a."targetId"
       WHERE t."workspaceId" = $1 AND a.id = ANY($2::uuid[]) AND ${scopeRulesSql(includes, params)!.where}`,
      params.values,
    );
    matchedAssets = new Set(rows.map((row) => row.id.toLowerCase()));
  }
  return Promise.all(
    rules.map(async (rule) => {
      if (rule.mode === Mode.EXCLUDE && !includes.length) return 0;
      if (
        matchedAssets &&
        rule.mode === Mode.EXCLUDE &&
        rule.type === Kind.ASSET
      )
        return matchedAssets.has(rule.value.toLowerCase()) ? 1 : 0;
      const params = new SqlParams([workspaceId]);
      let where = scopeRuleMatchSql(rule, params);
      if (rule.mode === Mode.EXCLUDE)
        where += ` AND ${scopeRulesSql(includes, params)!.where}`;
      const [row] = await dataSource.query<{ count: number }[]>(
        `SELECT COUNT(*)::int AS count FROM assets a JOIN targets t ON t.id = a."targetId"
       WHERE t."workspaceId" = $1 AND ${where}`,
        params.values,
      );
      return Number(row?.count ?? 0);
    }),
  );
}

@Injectable()
export class ProjectScopePreviewService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly normalizer: ProjectScopeNormalizer,
  ) {}

  async preview(
    workspaceId: string,
    input: ScopeRuleInput[],
    projectId?: string,
  ): Promise<ScopePreviewResult> {
    let scopedProjectId: string | null = null;
    if (projectId) {
      const [project] = await this.dataSource.query<{ id: string }[]>(
        `SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2`,
        [projectId, workspaceId],
      );
      if (!project) throw new NotFoundException('Project not found');
      scopedProjectId = project.id;
    }
    const rules = await this.normalizer.normalizeRules(workspaceId, input);
    const counts = await countScopeRules(this.dataSource, workspaceId, rules);
    const params = new SqlParams([scopedProjectId, workspaceId]);
    const built = scopeRulesSql(rules, params);
    const [row] = await this.dataSource.query<
      { ruleAssets: number; total: number }[]
    >(
      `WITH selected AS (SELECT a.id FROM assets a JOIN targets t ON t.id = a."targetId"
         WHERE t."workspaceId" = $2 AND ${built?.where ?? 'false'})
       SELECT (SELECT COUNT(*) FROM selected)::int AS "ruleAssets",
         (SELECT COUNT(*) FROM (
           SELECT id FROM selected UNION
           SELECT pa."assetId" FROM project_assets pa
           JOIN assets ma ON ma.id = pa."assetId" JOIN targets mt ON mt.id = ma."targetId"
           WHERE pa."projectId" = CAST($1 AS uuid) AND pa.source = 'manual' AND mt."workspaceId" = $2
         ) members)::int AS total`,
      params.values,
    );
    const key = (rule: ScopeRuleInput) =>
      `${rule.mode}|${rule.type}|${normalizeScopeRuleValue(rule.type, rule.value)}`;
    const byRule = new Map(rules.map((rule, i) => [key(rule), counts[i]]));
    return {
      ruleAssets: Number(row?.ruleAssets ?? 0),
      total: Number(row?.total ?? 0),
      // Duplicate canonical rules still need one result per original input row.
      perRule: input.map((rule) => byRule.get(key(rule)) ?? 0),
    };
  }
}
