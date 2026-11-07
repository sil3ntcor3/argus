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
        ), sightings AS (
          SELECT link.id AS link_id, legacy.run_id
          FROM project_vulnerabilities link
          CROSS JOIN LATERAL (VALUES (link."firstSeenJobHistoryId"), (link."lastSeenJobHistoryId")) legacy(run_id)
          JOIN page p ON p.id = legacy.run_id
          WHERE link."projectId" = $1
          UNION
          SELECT o."projectVulnerabilityId", o."jobHistoryId"
          FROM project_vulnerability_observations o JOIN page p ON p.id = o."jobHistoryId"
        ), findings AS (
          SELECT s.run_id,
            COUNT(*) FILTER (WHERE link."firstSeenJobHistoryId" = s.run_id)::int AS fresh,
            COUNT(*) FILTER (WHERE link."firstSeenJobHistoryId" IS DISTINCT FROM s.run_id)::int AS recurring
          FROM sightings s JOIN project_vulnerabilities link ON link.id = s.link_id
          JOIN vulnerabilities v ON v.id = link."vulnerabilityId"
          JOIN assets a ON a.id = v."assetId" JOIN targets t ON t.id = a."targetId"
          WHERE link."projectId" = $1 AND t."workspaceId" = $2
          GROUP BY s.run_id
        )
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
          scopeSize: Array.isArray(scope?.assetIds)
            ? scope.assetIds.length
            : Array.isArray(scope?.targetIds)
              ? scope.targetIds.length
              : 0,
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
}
