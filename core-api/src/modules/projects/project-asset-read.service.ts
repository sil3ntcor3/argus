import {
  GetManyBaseQueryParams,
  SortOrder,
} from '@/common/dtos/get-many-base.dto';
import {
  ProjectAssetSource,
  ProjectScopeRuleType,
  Severity,
  TargetType,
} from '@/common/enums/enum';
import { openVulnerabilityCondition } from '@/modules/vulnerabilities/open-vulnerability';
import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export type ProjectAssetReadQuery = GetManyBaseQueryParams & {
  source?: ProjectAssetSource;
};
export interface ProjectAssetView {
  id: string;
  value: string;
  targetId: string;
  targetValue: string;
  targetType: TargetType;
  source: ProjectAssetSource;
  addedAt: Date;
  rule: {
    id: string;
    type: ProjectScopeRuleType;
    value: string;
    label: string;
  } | null;
  vulnerabilities: Record<Severity, number>;
  lastScan: { runId: string; createdAt: Date } | null;
}
interface AssetRow extends Omit<
  ProjectAssetView,
  'rule' | 'vulnerabilities' | 'lastScan'
> {
  ruleId: string | null;
  ruleType: ProjectScopeRuleType;
  ruleValue: string;
  ruleLabel: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  lastScanRunId: string | null;
  lastScanAt: Date;
}

/** Private enriched member view. Existing public asset representations stay unchanged. */
@Injectable()
export class ProjectAssetReadService {
  constructor(private readonly dataSource: DataSource) {}

  async list(
    projectId: string,
    workspaceId: string,
    query: ProjectAssetReadQuery,
  ) {
    const [project] = await this.dataSource.query<{ id: string }[]>(
      'SELECT id FROM projects WHERE id=$1 AND "workspaceId"=$2',
      [projectId, workspaceId],
    );
    if (!project) throw new NotFoundException('Project not found');
    const { page, limit, search, source } = query;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid pagination');
    const params: unknown[] = [project.id, workspaceId];
    let where = 'pa."projectId"=$1 AND t."workspaceId"=$2';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND a.value ILIKE $${params.length}`;
    }
    if (source) {
      params.push(source);
      where += ` AND pa.source=$${params.length}`;
    }
    const join =
      'FROM project_assets pa JOIN assets a ON a.id=pa."assetId" JOIN targets t ON t.id=a."targetId"';
    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total ${join} WHERE ${where}`,
      params,
    );
    // Every dynamic value is bound. Unrecognized sort keys use membership time.
    const order = query.sortBy === 'value' ? 'a.value' : 'pa."createdAt"';
    const direction = query.sortOrder === SortOrder.ASC ? 'ASC' : 'DESC';
    params.push(limit, (page - 1) * limit);
    const rows = await this.dataSource.query<AssetRow[]>(
      `WITH page AS MATERIALIZED (
         SELECT a.id ${join} WHERE ${where}
         ORDER BY ${order} ${direction},a.id
         LIMIT $${params.length - 1} OFFSET $${params.length}
       ) SELECT a.id, a.value, t.id AS "targetId", t.value AS "targetValue", t.type AS "targetType",
              pa.source, pa."createdAt" AS "addedAt", r.id AS "ruleId", r.type AS "ruleType",
              r.value AS "ruleValue", COALESCE(rt.value, ra.value, r.value) AS "ruleLabel",
              vc.*, ls.id AS "lastScanRunId", ls."createdAt" AS "lastScanAt"
       ${join} JOIN page ON page.id=a.id
       LEFT JOIN project_scope_rules r ON r.id=pa."scopeRuleId" AND r."projectId"=pa."projectId"
       LEFT JOIN targets rt ON r.type='target' AND rt.id::text=lower(r.value) AND rt."workspaceId"=$2
       LEFT JOIN assets ra ON r.type='asset' AND ra.id::text=lower(r.value)
         AND EXISTS (SELECT 1 FROM targets rat WHERE rat.id=ra."targetId" AND rat."workspaceId"=$2)
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE v.severity='critical')::int AS critical,
                COUNT(*) FILTER (WHERE v.severity='high')::int AS high,
                COUNT(*) FILTER (WHERE v.severity='medium')::int AS medium,
                COUNT(*) FILTER (WHERE v.severity='low')::int AS low,
                COUNT(*) FILTER (WHERE v.severity='info')::int AS info
         FROM project_vulnerabilities pv JOIN vulnerabilities v ON v.id=pv."vulnerabilityId"
         WHERE pv."projectId"=pa."projectId" AND v."assetId"=a.id AND ${openVulnerabilityCondition('v')}
       ) vc ON true
       LEFT JOIN LATERAL (
         SELECT jh.id,jh."createdAt" FROM job_histories jh JOIN workflows w ON w.id=jh."workflowId"
         WHERE jh."projectId"=pa."projectId" AND w."workspaceId"=$2
           AND jsonb_typeof(jh.scope->'assetIds')='array' AND jh.scope->'assetIds' ? a.id::text
         ORDER BY jh."createdAt" DESC,jh.id DESC LIMIT 1
       ) ls ON true
       WHERE ${where} ORDER BY ${order} ${direction},a.id`,
      params,
    );
    const data: ProjectAssetView[] = rows.map((row) => ({
      id: row.id,
      value: row.value,
      targetId: row.targetId,
      targetValue: row.targetValue,
      targetType: row.targetType,
      source: row.source,
      addedAt: row.addedAt,
      rule: row.ruleId
        ? {
            id: row.ruleId,
            type: row.ruleType,
            value: row.ruleValue,
            label: row.ruleLabel,
          }
        : null,
      vulnerabilities: {
        critical: row.critical,
        high: row.high,
        medium: row.medium,
        low: row.low,
        info: row.info,
      },
      lastScan: row.lastScanRunId
        ? { runId: row.lastScanRunId, createdAt: row.lastScanAt }
        : null,
    }));
    return getManyResponse({ query, data, total });
  }
}
