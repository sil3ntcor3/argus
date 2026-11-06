import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { normalizeScopeRuleValue, type ScopeRuleLike } from './scope-rules';

export type ScopeRuleInput = Omit<ScopeRuleLike, 'id'>;

/** Internal preparation for scope preview and persistence; does not save rules. */
@Injectable()
export class ProjectScopeNormalizer {
  constructor(private readonly dataSource: DataSource) {}

  async normalizeRules(
    workspaceId: string,
    rules: ScopeRuleInput[],
  ): Promise<ScopeRuleInput[]> {
    const normalized = rules.map((rule) => {
      if (rule.mode !== Mode.INCLUDE && rule.mode !== Mode.EXCLUDE) {
        throw new BadRequestException('Invalid scope rule mode');
      }
      try {
        return {
          mode: rule.mode,
          type: rule.type,
          value: normalizeScopeRuleValue(rule.type, rule.value),
        };
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Invalid scope rule',
        );
      }
    });

    const idsOf = (type: Kind) => [
      ...new Set(normalized.filter((r) => r.type === type).map((r) => r.value)),
    ];
    const targetIds = idsOf(Kind.TARGET);
    if (targetIds.length) {
      const found = await this.dataSource.query<{ id: string }[]>(
        `SELECT id FROM targets WHERE id = ANY($1::uuid[]) AND "workspaceId" = $2`,
        [targetIds, workspaceId],
      );
      this.requireAll(targetIds, found, 'Target');
    }
    const assetIds = idsOf(Kind.ASSET);
    if (assetIds.length) {
      const found = await this.dataSource.query<{ id: string }[]>(
        `SELECT a.id FROM assets a JOIN targets t ON t.id = a."targetId"
         WHERE t."workspaceId" = $1 AND a.id = ANY($2::uuid[])`,
        [workspaceId, assetIds],
      );
      this.requireAll(assetIds, found, 'Asset');
    }

    const seen = new Set<string>();
    return normalized.filter((rule) => {
      const key = `${rule.mode}|${rule.type}|${rule.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private requireAll(ids: string[], found: { id: string }[], label: string) {
    const present = new Set(found.map((row) => row.id));
    const missing = ids.find((id) => !present.has(id));
    if (missing)
      throw new BadRequestException(`${label} "${missing}" not found`);
  }
}
