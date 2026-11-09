import { Severity } from '@/common/enums/enum';
import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VulnerabilityStatus } from '../vulnerabilities/dto/get-vulnerability.dto';
import {
  activeDismissalCondition,
  openVulnerabilityCondition,
} from '../vulnerabilities/open-vulnerability';
import {
  PROJECT_FINDING_PROVENANCE_SQL,
  ProjectFindingProvenance,
  projectFindingReferenceRunJoin,
} from './project-finding-provenance';

interface ProjectFindingQuery {
  page: number;
  limit: number;
  status?: VulnerabilityStatus;
  search?: string;
  severity?: Severity[];
  provenance?: ProjectFindingProvenance;
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

type CountedFindingRow = (FindingRow | { id: null }) & {
  total: number;
  provenanceCounts: {
    all: number;
    new: number;
    recurring: number;
    notSeen: number;
  };
  severityCounts: Record<Severity, number>;
};

const DISMISSED_SQL = `EXISTS (
  SELECT 1 FROM vulnerability_dismissals vd WHERE vd."vulnerabilityId" = v.id
    AND ${activeDismissalCondition('vd')}
)`;
const RANK_SQL = `CASE v.severity
  WHEN '${Severity.CRITICAL}' THEN 5 WHEN '${Severity.HIGH}' THEN 4
  WHEN '${Severity.MEDIUM}' THEN 3 WHEN '${Severity.LOW}' THEN 2 ELSE 1 END`;

@Injectable()
export class ProjectFindingReadService {
  constructor(private readonly dataSource: DataSource) {}

  async get(
    projectId: string,
    workspaceId: string,
    findingId: string,
    executor: Pick<DataSource, 'query'> = this.dataSource,
  ) {
    if (!findingId) throw new NotFoundException('Project finding not found');
    const {
      data: [finding],
    } = await this.readPage(
      projectId,
      workspaceId,
      { page: 1, limit: 1, status: VulnerabilityStatus.ALL },
      executor,
      findingId,
    );
    if (!finding) throw new NotFoundException('Project finding not found');
    return finding;
  }

  list(projectId: string, workspaceId: string, query: ProjectFindingQuery) {
    return this.readPage(projectId, workspaceId, query, this.dataSource);
  }

  private async readPage(
    projectId: string,
    workspaceId: string,
    query: ProjectFindingQuery,
    executor: Pick<DataSource, 'query'>,
    findingId?: string,
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
    const conditions = ['true'];
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
    if (findingId !== undefined)
      conditions.push(`pv."vulnerabilityId" = ${add(findingId)}`);
    const severitySelected = query.severity?.length
      ? `v.severity::text = ANY(${add(query.severity)}::text[])`
      : 'true';
    const provenanceSelected = query.provenance
      ? `provenance = ${add(query.provenance)}`
      : 'true';
    let sightingCtes = '';
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
    }
    const paging = `LIMIT ${add(limit)} OFFSET ${add(offset)}`;
    // The severity facet needs classification outside the selected severities
    // only when a provenance filter is active.
    const classify = query.provenance ? 'true' : '"severitySelected"';
    const severitySource = query.provenance ? 'classified' : 'matching';
    const provenanceCount = (value: ProjectFindingProvenance) =>
      `COUNT(*) FILTER (WHERE "severitySelected" AND provenance = '${value}')::int`;
    const severityCountsSql = Object.values(Severity)
      .map(
        (severity) =>
          `'${severity}', COUNT(*) FILTER (WHERE severity = '${severity}' AND ${provenanceSelected})::int`,
      )
      .join(', ');
    const findingSelect = `SELECT pv.id, v.id AS vulnerability_id, v.severity, v."assetId", v."toolId",
      pv."projectId", pv."timesSeen", pv."firstSeenAt", pv."lastSeenAt",
      pv."firstSeenJobHistoryId", pv."lastSeenJobHistoryId",
      ${RANK_SQL} AS rank, ${severitySelected} AS "severitySelected"`;
    // Keep each lookup on its unique key even when table statistics
    // underestimate newly ingested findings on one asset.
    const findingJoins = `CROSS JOIN LATERAL (
        SELECT id, severity, "assetId", "toolId", name, "cveId", "isArchived"
        FROM vulnerabilities WHERE id = pv."vulnerabilityId" LIMIT 1
      ) v
      CROSS JOIN LATERAL (
        SELECT id, value, "targetId" FROM assets WHERE id = v."assetId" LIMIT 1
      ) a
      CROSS JOIN LATERAL (
        SELECT 1 FROM targets WHERE id = a."targetId" AND "workspaceId" = $2 LIMIT 1
      ) t`;
    const where = conditions.join(' AND ');
    // Keep the whole ownership and finding lookup on the inside of the
    // bounded primary-key probe. The planner cannot drive it from every
    // finding and rescan the materialized sighting set.
    const matching = sightingCtes
      ? `SELECT candidate.* FROM owned CROSS JOIN sighted_links s
         CROSS JOIN LATERAL (
           ${findingSelect} FROM project_vulnerabilities pv ${findingJoins}
           WHERE pv.id = s.id AND pv."projectId" = owned.id AND ${where}
           LIMIT 1
         ) candidate`
      : `${findingSelect}
         FROM owned JOIN project_vulnerabilities pv ON pv."projectId" = owned.id
         ${findingJoins} WHERE ${where}`;

    // Reuse one reference per asset/tool across the facet counts and page.
    const rows = await executor.query<CountedFindingRow[]>(
      `WITH owned AS (SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2),
        ${sightingCtes}
        matching AS MATERIALIZED (
          ${matching}
        ), reference_runs AS MATERIALIZED (
          SELECT k."assetId", k."toolId", ref.id, ref."createdAt"
          FROM (
            SELECT DISTINCT "assetId", "toolId" FROM matching
            WHERE "toolId" IS NOT NULL AND ${classify}
          ) k
          ${projectFindingReferenceRunJoin('$1', 'k."assetId"', 'k."toolId"')}
        ), seen_runs AS MATERIALIZED (
          SELECT h.id, h."createdAt"
          FROM (
            SELECT DISTINCT "lastSeenJobHistoryId" FROM matching
            WHERE "lastSeenJobHistoryId" IS NOT NULL AND ${classify}
          ) k
          JOIN job_histories h ON h.id = k."lastSeenJobHistoryId" AND h."projectId" = $1
          JOIN workflows w ON w.id = h."workflowId" AND w."workspaceId" = $2
        ), classified AS MATERIALIZED (
          SELECT pv.*, ${PROJECT_FINDING_PROVENANCE_SQL} AS provenance,
                 seen_run.id AS "lastRunId"
          FROM matching pv
          LEFT JOIN reference_runs ref ON ref."assetId" = pv."assetId" AND ref."toolId" = pv."toolId"
          LEFT JOIN seen_runs seen_run ON seen_run.id = pv."lastSeenJobHistoryId"
          WHERE ${classify}
        ), counts AS (
          SELECT COUNT(*) FILTER (WHERE "severitySelected" AND ${provenanceSelected})::int AS total,
                 jsonb_build_object(
                   'all', COUNT(*) FILTER (WHERE "severitySelected")::int,
                   'new', ${provenanceCount(ProjectFindingProvenance.NEW)},
                   'recurring', ${provenanceCount(ProjectFindingProvenance.RECURRING)},
                   'notSeen', ${provenanceCount(ProjectFindingProvenance.NOT_SEEN)}
                 ) AS "provenanceCounts"
          FROM classified
        ), severity_counts AS (
          SELECT jsonb_build_object(${severityCountsSql}) AS "severityCounts" FROM ${severitySource}
        ), page AS MATERIALIZED (
          SELECT * FROM classified WHERE "severitySelected" AND ${provenanceSelected}
          ORDER BY rank DESC, "lastSeenAt" DESC, vulnerability_id
          ${paging}
        )
        SELECT counts.total, counts."provenanceCounts", severity_counts."severityCounts",
               v.id, v.name, v.severity, v."cveId", v."affectedUrl",
               a.id AS "assetId", a.value AS "assetValue", tool.name AS "toolName",
               CASE WHEN ${DISMISSED_SQL} THEN 'dismissed' ELSE 'open' END AS status,
               page.provenance, page."timesSeen",
               first_run.id AS "firstRunId", page."firstSeenAt",
               page."lastRunId", page."lastSeenAt"
        FROM owned CROSS JOIN counts CROSS JOIN severity_counts
        LEFT JOIN page ON true
        LEFT JOIN vulnerabilities v ON v.id = page.vulnerability_id
        LEFT JOIN assets a ON a.id = v."assetId"
        LEFT JOIN tools tool ON tool.id = v."toolId"
        LEFT JOIN LATERAL (
          SELECT h.id FROM job_histories h JOIN workflows w ON w.id = h."workflowId"
          WHERE h.id = page."firstSeenJobHistoryId" AND h."projectId" = owned.id
            AND w."workspaceId" = $2
        ) first_run ON true
        ORDER BY page.rank DESC, page."lastSeenAt" DESC, page.vulnerability_id`,
      params,
    );
    if (!rows.length) throw new NotFoundException('Project not found');
    const [{ total, provenanceCounts, severityCounts }] = rows;
    const data = rows
      .filter((row) => row.id !== null)
      .map(
        ({
          total: _total,
          provenanceCounts: _provenanceCounts,
          severityCounts: _severityCounts,
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
    return {
      ...getManyResponse({
        query: { page, limit, sortBy: 'lastSeenAt' },
        data,
        total,
      }),
      provenanceCounts,
      severityCounts,
    };
  }
}
