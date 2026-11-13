import type { JobRunType, JobStatus } from '@/common/enums/enum';
import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JOB_HISTORY_STATUS_SQL } from '../jobs-registry/job-history-status';
import type { WorkflowContent } from '../workflows/entities/workflow.entity';
import {
  jobEntries,
  type WorkflowRunScope,
  type WorkflowRunStepStates,
} from '../workflows/workflow-graph';
import { PROJECT_ACTIVITY_LIMIT } from './project-overview-activity.service';

interface ProjectRunQuery {
  page: number;
  limit: number;
  projectWorkflowId?: string;
  jobRunType?: JobRunType;
}

interface RunRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  isCompleted: boolean;
  jobRunType: JobRunType;
  projectWorkflowId: string | null;
  workflowName: string;
  status: JobStatus;
  scope: WorkflowRunScope | null;
  steps: WorkflowRunStepStates | null;
  workflowContent: Pick<WorkflowContent, 'jobs'> | null;
  newVulnerabilities: number;
  recurringVulnerabilities: number;
}

type CountedRunRow = (RunRow | { id: null }) & { total: number };

type ActivityRunRow = Pick<
  RunRow,
  | 'id'
  | 'workflowName'
  | 'scope'
  | 'jobRunType'
  | 'newVulnerabilities'
  | 'recurringVulnerabilities'
> & { at: Date; runStatus: JobStatus };

const savedScopeSize = (scope: WorkflowRunScope | null) =>
  Array.isArray(scope?.assetIds)
    ? scope.assetIds.length
    : Array.isArray(scope?.targetIds)
      ? scope.targetIds.length
      : 0;

// Both reads materialize a bounded run page. Group sightings by finding so
// each ownership lookup runs once even when a finding appears in many runs.
const RUN_FINDING_COUNTS = `sightings AS (
  SELECT link.id AS link_id, legacy.run_id
  FROM project_vulnerabilities link
  CROSS JOIN LATERAL (VALUES (link."firstSeenJobHistoryId"), (link."lastSeenJobHistoryId")) legacy(run_id)
  WHERE link."projectId" = $1
    AND legacy.run_id = ANY(ARRAY(SELECT id FROM page))
  UNION
  SELECT o."projectVulnerabilityId", o."jobHistoryId"
  FROM project_vulnerability_observations o
  WHERE o."jobHistoryId" = ANY(ARRAY(SELECT id FROM page))
), sighted_links AS MATERIALIZED (
  SELECT link_id, array_agg(run_id) AS run_ids FROM sightings GROUP BY link_id
), owned_links AS MATERIALIZED (
  SELECT s.run_ids, link."firstSeenJobHistoryId"
  FROM sighted_links s
  JOIN LATERAL (
    SELECT pv."projectId", pv."firstSeenJobHistoryId", pv."vulnerabilityId"
    FROM project_vulnerabilities pv WHERE pv.id = s.link_id
    LIMIT 1
  ) link ON link."projectId" = $1
  JOIN LATERAL (
    SELECT v."assetId" FROM vulnerabilities v WHERE v.id = link."vulnerabilityId" AND v."reviewStatus"='approved' LIMIT 1
  ) v ON true
  JOIN LATERAL (
    SELECT a."targetId" FROM assets a WHERE a.id = v."assetId" LIMIT 1
  ) a ON true
  JOIN LATERAL (
    SELECT t."workspaceId" FROM targets t WHERE t.id = a."targetId" LIMIT 1
  ) t ON t."workspaceId" = $2
), findings AS MATERIALIZED (
  SELECT history.run_id,
    COUNT(*) FILTER (WHERE link."firstSeenJobHistoryId" = history.run_id)::int AS fresh,
    COUNT(*) FILTER (WHERE link."firstSeenJobHistoryId" IS DISTINCT FROM history.run_id)::int AS recurring
  FROM owned_links link CROSS JOIN LATERAL unnest(link.run_ids) history(run_id)
  GROUP BY history.run_id
)`;

@Injectable()
export class ProjectRunReadService {
  constructor(private readonly dataSource: DataSource) {}

  /** Pages owned run history before computing status, steps and findings. */
  async list(projectId: string, workspaceId: string, query: ProjectRunQuery) {
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
      throw new BadRequestException('Invalid project run pagination');
    const params: unknown[] = [projectId, workspaceId];
    const base = `FROM job_histories jh
      JOIN owned ON owned.id = jh."projectId"
      JOIN workflows w ON w.id = jh."workflowId"
      LEFT JOIN project_workflows pw ON pw.id = jh."projectWorkflowId"
        AND pw."projectId" = jh."projectId" AND pw."workflowId" = jh."workflowId"
      WHERE jh."projectId" = $1 AND w."workspaceId" = $2
      ${query.projectWorkflowId ? `AND pw.id = $${params.push(query.projectWorkflowId)}` : ''}
      ${query.jobRunType ? `AND jh."jobRunType" = $${params.push(query.jobRunType)}` : ''}`;
    // One statement keeps ownership, count and page on the same snapshot.
    // Inlining matching lets the count avoid loading workflow content.
    const rows = await this.dataSource.query<CountedRunRow[]>(
      `WITH owned AS (SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2),
        matching AS NOT MATERIALIZED (
          SELECT jh.id, jh."createdAt", jh."updatedAt", jh."isCompleted", jh."jobRunType",
                 pw.id AS "projectWorkflowId", jh.scope, jh.steps,
                 w.name AS "workflowName", w.content AS "workflowContent"
          ${base}
        ), page AS MATERIALIZED (
          SELECT * FROM matching ORDER BY "createdAt" DESC, id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        ), ${RUN_FINDING_COUNTS}
        SELECT totals.total, p.*,
               (SELECT ${JOB_HISTORY_STATUS_SQL} FROM jobs job WHERE job."jobHistoryId" = p.id) AS status,
               COALESCE(f.fresh, 0) AS "newVulnerabilities",
               COALESCE(f.recurring, 0) AS "recurringVulnerabilities"
        FROM owned CROSS JOIN (SELECT COUNT(*)::int AS total FROM matching) totals
        LEFT JOIN page p ON true
        LEFT JOIN findings f ON f.run_id = p.id
        ORDER BY p."createdAt" DESC, p.id DESC`,
      [...params, limit, offset],
    );
    if (!rows.length) throw new NotFoundException('Project not found');
    const [{ total }] = rows;
    const data = rows
      .filter((row) => row.id !== null)
      .map(({ total: _total, scope, steps, workflowContent, ...run }) => {
        const states =
          steps && typeof steps === 'object' && !Array.isArray(steps)
            ? Object.values(steps).filter(Boolean)
            : [];
        return {
          ...run,
          scopeSize: savedScopeSize(scope),
          stepsTotal: Math.max(
            states.length,
            jobEntries(workflowContent?.jobs).length,
          ),
          stepsDone: states.filter(
            ({ status, reason }) =>
              status === 'done' ||
              (status === 'skipped' &&
                (reason === 'no-inputs' || reason === 'assets-discovery-off')),
          ).length,
          stepsFailed: states.filter(({ status }) => status === 'failed')
            .length,
        };
      });
    return getManyResponse({
      query: { ...query, sortBy: 'createdAt' },
      data,
      total,
    });
  }

  async listActivity(
    projectId: string,
    workspaceId: string,
    executor: Pick<DataSource, 'query'> = this.dataSource,
  ) {
    const rows = await executor.query<(ActivityRunRow | { id: null })[]>(
      `WITH owned AS (SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2),
        page AS MATERIALIZED (
          -- Convert the saved wall clock to an instant for the combined feed.
          SELECT h.id, h."createdAt"::timestamptz AS at, h."jobRunType", h.scope,
                 w.name AS "workflowName"
          FROM owned p JOIN job_histories h ON h."projectId" = p.id
          JOIN workflows w ON w.id = h."workflowId" AND w."workspaceId" = $2
          WHERE h."createdAt" <= LOCALTIMESTAMP
          ORDER BY h."createdAt" DESC, h.id DESC LIMIT ${PROJECT_ACTIVITY_LIMIT}
        ), ${RUN_FINDING_COUNTS}
        SELECT p.*, (SELECT ${JOB_HISTORY_STATUS_SQL} FROM jobs job
                     WHERE job."jobHistoryId" = p.id) AS "runStatus",
               COALESCE(f.fresh, 0) AS "newVulnerabilities",
               COALESCE(f.recurring, 0) AS "recurringVulnerabilities"
        FROM owned LEFT JOIN page p ON true LEFT JOIN findings f ON f.run_id = p.id
        ORDER BY p.at DESC, p.id DESC`,
      [projectId, workspaceId],
    );
    if (rows.length === 0) throw new NotFoundException('Project not found');
    return rows
      .filter((row) => row.id !== null)
      .map(({ id, scope, ...run }) => ({
        ...run,
        kind: 'run' as const,
        ref: id,
        scopeSize: savedScopeSize(scope),
      }));
  }
}
