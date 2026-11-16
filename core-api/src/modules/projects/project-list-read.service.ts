import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SortOrder } from '@/common/dtos/get-many-base.dto';
import { Severity } from '@/common/enums/enum';
import { getManyResponse } from '@/utils/getManyResponse';
import { openVulnerabilityCondition } from '../vulnerabilities/open-vulnerability';
import type { GetProjectsQueryDto } from './dto/project-list.dto';
import type { ProjectListItemDto } from './dto/project-list-item.dto';
import { PROJECT_TRIGGER_EVENTS } from './dto/project-trigger-read.dto';

const sortColumns = new Set(['id', 'name', 'createdAt', 'updatedAt', 'hexColor', 'description', 'instruction', 'autoAddAssets', 'archivedAt', 'totalAssets', 'lastRunAt']);
type CountedRow = (ProjectListItemDto | { id: null }) & { total: number };

/** Page project metadata before bounded summaries; risk ordering alone needs all candidate counts. */
@Injectable()
export class ProjectListReadService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: GetProjectsQueryDto, workspaceId: string, canReadFindings: boolean) {
    const { page, limit, sortBy } = query;
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset))
      throw new BadRequestException('Invalid project pagination');
    const risk = sortBy === 'risk';
    if (risk && !canReadFindings) throw new ForbiddenException('Vulnerability read access is required for risk sorting');
    if (!risk && !sortColumns.has(sortBy)) throw new BadRequestException('Unsupported project sort');
    const direction = query.sortOrder === SortOrder.DESC ? 'DESC' : 'ASC';
    const order = risk
      ? ['critical', 'high', 'medium'].map(key => `("openVulnerabilities"->>'${key}')::int ${direction}`).concat('id ASC').join(', ')
      : `"${sortBy}" ${direction} NULLS LAST, id ASC`;
    const params: unknown[] = [workspaceId, canReadFindings];
    const add = (value: unknown) => '$' + params.push(value);
    const where = ['p."workspaceId" = $1'];
    if (query.status !== 'all') where.push(`p."archivedAt" IS ${query.status === 'archived' ? 'NOT ' : ''}NULL`);
    if (query.search?.trim()) where.push(`p.name ILIKE ${add('%' + query.search.trim() + '%')}`);
    if (query.targetIds?.length) where.push(`EXISTS (SELECT 1 FROM project_assets pa JOIN assets a ON a.id=pa."assetId"
      JOIN targets t ON t.id=a."targetId" AND t."workspaceId"=$1
      WHERE pa."projectId"=p.id AND t.id=ANY(${add(query.targetIds)}::uuid[]))`);
    const paging = `LIMIT ${add(limit)} OFFSET ${add(offset)}`;
    const buckets = Object.values(Severity).map(severity => {
      const condition = severity === Severity.INFO ? "COALESCE(v.severity NOT IN ('critical','high','medium','low'),true)" : `v.severity='${severity}'`;
      return `'${severity}', COUNT(*) FILTER (WHERE ${condition})::int`;
    }).join(', ');
    const events = add(PROJECT_TRIGGER_EVENTS);
    const rows = await this.dataSource.query<CountedRow[]>(`WITH matching AS NOT MATERIALIZED (
      SELECT p.id, p.name, p."createdAt", p."updatedAt", p."hexColor", p.description, p.instruction,
        p."autoAddAssets", p."archivedAt",
        (SELECT COUNT(*)::int FROM project_assets pa JOIN assets a ON a.id=pa."assetId"
          JOIN targets t ON t.id=a."targetId" AND t."workspaceId"=$1 WHERE pa."projectId"=p.id) AS "totalAssets",
        (SELECT COUNT(*)::int FROM project_workflows pw JOIN workflows w ON w.id=pw."workflowId"
          AND w."workspaceId"=$1 WHERE pw."projectId"=p.id) AS "workflowCount",
        (SELECT MAX(h."createdAt") FROM job_histories h JOIN workflows w ON w.id=h."workflowId"
          AND w."workspaceId"=$1 WHERE h."projectId"=p.id) AS "lastRunAt"
      FROM projects p WHERE ${where.join(' AND ')}
    ), candidates AS MATERIALIZED (
      SELECT * FROM matching ${risk ? '' : `ORDER BY ${order} ${paging}`}
    ), enriched AS (
      SELECT p.*, CASE WHEN $2::boolean THEN f.counts END AS "openVulnerabilities",
        CASE WHEN $2::boolean THEN f.fresh END AS "newVulnerabilities"
      FROM candidates p CROSS JOIN LATERAL (
        SELECT jsonb_build_object(${buckets}) AS counts,
          COUNT(*) FILTER (WHERE pv."firstSeenAt" > statement_timestamp()-interval '168 hours'
            AND pv."firstSeenAt" <= statement_timestamp())::int AS fresh
        FROM project_vulnerabilities pv
        JOIN LATERAL (SELECT v.id,v.severity,v."reviewStatus",v."isArchived",v."detectionStatus"
          FROM vulnerabilities v JOIN assets a ON a.id=v."assetId"
          JOIN targets t ON t.id=a."targetId" AND t."workspaceId"=$1
          WHERE v.id=pv."vulnerabilityId" OFFSET 0) v ON true
        WHERE $2::boolean AND pv."projectId"=p.id AND ${openVulnerabilityCondition('v')}
      ) f
    ), page AS MATERIALIZED (
      SELECT * FROM enriched ${risk ? `ORDER BY ${order} ${paging}` : ''}
    )
    SELECT totals.total, page.*, COALESCE(tr.triggers,'[]'::jsonb) AS triggers
    FROM (SELECT COUNT(*)::int AS total FROM matching) totals LEFT JOIN page ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',t.id,'projectWorkflowId',pw.id,'type',t.type,
        'cron',CASE WHEN t.type='cron' THEN t.cron END,
        'event',CASE WHEN t.type='event' AND t.event=ANY(${events}::text[]) THEN t.event END,
        'enabled',t.enabled) ORDER BY t."createdAt",t.id) AS triggers
      FROM project_workflows pw JOIN workflows w ON w.id=pw."workflowId" AND w."workspaceId"=$1
      JOIN project_workflow_triggers t ON t."projectWorkflowId"=pw.id
      WHERE pw."projectId"=page.id AND t.type IN ('cron','event')
    ) tr ON true ORDER BY ${order}`, params);
    const total = rows[0]?.total ?? 0;
    const data = rows.filter(row => row.id !== null).map(({ total: _total, ...row }) => row);
    return getManyResponse({ query, data, total });
  }
}
