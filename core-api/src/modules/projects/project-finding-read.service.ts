import { Severity } from '@/common/enums/enum';
import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VulnerabilityStatus } from '../vulnerabilities/dto/get-vulnerability.dto';
import { openVulnerabilityCondition } from '../vulnerabilities/open-vulnerability';
import {
  PROJECT_FINDING_PROVENANCE_SQL,
  PROJECT_FINDING_REFERENCE_JOINS,
  type ProjectFindingProvenance,
} from './project-finding-provenance';

interface ProjectFindingQuery {
  page: number;
  limit: number;
  status?: VulnerabilityStatus;
  search?: string;
  severity?: Severity[];
  assetId?: string;
  jobHistoryId?: string;
  projectWorkflowId?: string;
}

interface FindingRow {
  id: string;
  name: string;
  severity: Severity;
  cveId: string[] | null;
  affectedUrl: string | null;
  assetId: string;
  assetValue: string;
  toolName: string | null;
  status: VulnerabilityStatus.OPEN | VulnerabilityStatus.DISMISSED;
  provenance: ProjectFindingProvenance;
  timesSeen: number;
  firstRunId: string | null;
  firstSeenAt: Date;
  lastRunId: string | null;
  lastSeenAt: Date;
}

type CountedFindingRow = (FindingRow | { id: null }) & { total: number };

const DISMISSED_SQL = `EXISTS (
  SELECT 1 FROM vulnerability_dismissals vd WHERE vd."vulnerabilityId" = v.id
)`;
const RANK_SQL = `CASE v.severity
  WHEN '${Severity.CRITICAL}' THEN 5 WHEN '${Severity.HIGH}' THEN 4
  WHEN '${Severity.MEDIUM}' THEN 3 WHEN '${Severity.LOW}' THEN 2 ELSE 1 END`;

@Injectable()
export class ProjectFindingReadService {
  constructor(private readonly dataSource: DataSource) {}

  async list(
    projectId: string,
    workspaceId: string,
    query: ProjectFindingQuery,
  ) {
    const { page, limit } = query;
    const offset = (page - 1) * limit;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset)
    )
      throw new BadRequestException('Invalid project finding pagination');

    const params: unknown[] = [projectId, workspaceId];
    const add = (value: unknown) => `$${params.push(value)}`;
    const conditions = ['t."workspaceId" = $2'];
    const status = query.status ?? VulnerabilityStatus.OPEN;
    if (status === VulnerabilityStatus.OPEN)
      conditions.push(openVulnerabilityCondition('v'));
    else if (status === VulnerabilityStatus.DISMISSED)
      conditions.push(DISMISSED_SQL);
    if (query.search) {
      const pattern = add(`%${query.search.replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(
        `(v.name ILIKE ${pattern} OR a.value ILIKE ${pattern} OR array_to_string(v."cveId", ' ') ILIKE ${pattern})`,
      );
    }
    if (query.assetId) conditions.push(`a.id = ${add(query.assetId)}`);
    if (query.severity?.length)
      conditions.push(`v.severity::text = ANY(${add(query.severity)}::text[])`);
    let sightingCtes = '';
    let sightingJoin = '';
    if (query.jobHistoryId || query.projectWorkflowId) {
      const run = query.jobHistoryId ? add(query.jobHistoryId) : null;
      const binding = query.projectWorkflowId
        ? add(query.projectWorkflowId)
        : null;
      // Resolve eligible runs once. Applying both predicates here requires
      // the same sighting to match both filters.
      sightingCtes = `sighting_runs AS MATERIALIZED (
        SELECT h.id FROM owned JOIN job_histories h ON h."projectId" = owned.id
        JOIN workflows w ON w.id = h."workflowId" AND w."workspaceId" = $2
        ${
          binding
            ? `JOIN project_workflows pw ON pw.id = h."projectWorkflowId"
          AND pw.id = ${binding} AND pw."projectId" = owned.id AND pw."workflowId" = h."workflowId"`
            : ''
        }
        ${run ? `WHERE h.id = ${run}` : ''}
      ), sighted_links AS MATERIALIZED (
        SELECT o."projectVulnerabilityId" AS id FROM sighting_runs r
          JOIN project_vulnerability_observations o ON o."jobHistoryId" = r.id
        UNION
        SELECT link.id FROM owned
        JOIN project_vulnerabilities link ON link."projectId" = owned.id
        CROSS JOIN LATERAL (VALUES (link."firstSeenJobHistoryId"), (link."lastSeenJobHistoryId")) legacy(run_id)
        JOIN sighting_runs r ON r.id = legacy.run_id
      ),`;
      sightingJoin = 'JOIN sighted_links s ON s.id = pv.id';
    }
    const paging = `LIMIT ${add(limit)} OFFSET ${add(offset)}`;

    // Keep ownership, count and page on one snapshot, and only classify page rows.
    const rows = await this.dataSource.query<CountedFindingRow[]>(
      `WITH owned AS (SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2),
        ${sightingCtes}
        matching AS NOT MATERIALIZED (
          SELECT pv.id AS link_id, v.id, pv."lastSeenAt", ${RANK_SQL} AS rank
          FROM owned JOIN project_vulnerabilities pv ON pv."projectId" = owned.id
          ${sightingJoin}
          JOIN vulnerabilities v ON v.id = pv."vulnerabilityId"
          JOIN assets a ON a.id = v."assetId" JOIN targets t ON t.id = a."targetId"
          WHERE ${conditions.join(' AND ')}
        ), page AS MATERIALIZED (
          SELECT * FROM matching ORDER BY rank DESC, "lastSeenAt" DESC, id
          ${paging}
        )
        SELECT totals.total, v.id, v.name, v.severity, v."cveId", v."affectedUrl",
               a.id AS "assetId", a.value AS "assetValue", tool.name AS "toolName",
               CASE WHEN ${DISMISSED_SQL} THEN 'dismissed' ELSE 'open' END AS status,
               ${PROJECT_FINDING_PROVENANCE_SQL} AS provenance, pv."timesSeen",
               first_run.id AS "firstRunId", pv."firstSeenAt",
               seen_run.id AS "lastRunId", pv."lastSeenAt"
        FROM owned CROSS JOIN (SELECT COUNT(*)::int AS total FROM matching) totals
        LEFT JOIN page ON true
        LEFT JOIN project_vulnerabilities pv ON pv.id = page.link_id
        LEFT JOIN vulnerabilities v ON v.id = page.id
        LEFT JOIN assets a ON a.id = v."assetId"
        LEFT JOIN tools tool ON tool.id = v."toolId"
        LEFT JOIN LATERAL (
          SELECT h.id FROM job_histories h JOIN workflows w ON w.id = h."workflowId"
          WHERE h.id = pv."firstSeenJobHistoryId" AND h."projectId" = owned.id
            AND w."workspaceId" = $2
        ) first_run ON true
        ${PROJECT_FINDING_REFERENCE_JOINS}
        ORDER BY page.rank DESC, page."lastSeenAt" DESC, page.id`,
      params,
    );
    if (!rows.length) throw new NotFoundException('Project not found');
    const [{ total }] = rows;
    const data = rows
      .filter((row) => row.id !== null)
      .map(
        ({
          total: _total,
          firstRunId,
          firstSeenAt,
          lastRunId,
          lastSeenAt,
          ...row
        }) => ({
          ...row,
          firstSeen: { runId: firstRunId, at: firstSeenAt },
          lastSeen: { runId: lastRunId, at: lastSeenAt },
        }),
      );
    return getManyResponse({
      query: { page, limit, sortBy: 'lastSeenAt' },
      data,
      total,
    });
  }
}
