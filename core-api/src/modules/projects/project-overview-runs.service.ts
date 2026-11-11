import type { JobRunType, JobStatus } from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JOB_HISTORY_STATUS_SQL } from '../jobs-registry/job-history-status';

interface ProjectOverviewRun {
  id: string;
  createdAt: Date;
  workflowName: string;
  jobRunType: JobRunType;
  status: JobStatus;
}

type SelectedRun =
  (ProjectOverviewRun & { latest: boolean; fresh: boolean }) | { id: null };

@Injectable()
export class ProjectOverviewRunsService {
  constructor(private readonly dataSource: DataSource) {}

  async read(
    projectId: string,
    workspaceId: string,
    asOf?: Date,
    executor: Pick<DataSource, 'query'> = this.dataSource,
  ) {
    const rows = await executor.query<SelectedRun[]>(
      `WITH owned AS (
        SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2
      ), reference_time AS (
        SELECT COALESCE($3::timestamptz, now()) AS at
      ), run_details AS NOT MATERIALIZED (
        SELECT h.id, h."createdAt", w.name AS "workflowName", h."jobRunType"
        FROM owned p JOIN job_histories h ON h."projectId" = p.id
        JOIN workflows w ON w.id = h."workflowId" AND w."workspaceId" = $2
        WHERE h."createdAt" <= (SELECT at::timestamp FROM reference_time)
      ), latest AS (
        SELECT * FROM run_details ORDER BY "createdAt" DESC, id DESC LIMIT 1
      ), discovery_ids AS MATERIALIZED (
        -- Retain discoveries after dismissal, but reject cross-workspace links.
        SELECT DISTINCT pv."firstSeenJobHistoryId" AS id
        FROM owned p JOIN project_vulnerabilities pv ON pv."projectId" = p.id
        CROSS JOIN reference_time r
        JOIN LATERAL (
          SELECT 1 FROM vulnerabilities v JOIN assets a ON a.id = v."assetId"
          JOIN targets t ON t.id = a."targetId" AND t."workspaceId" = $2
          WHERE v.id = pv."vulnerabilityId"
          LIMIT 1
        ) valid ON true
        WHERE pv."firstSeenJobHistoryId" IS NOT NULL
          AND pv."firstSeenAt" > r.at - interval '168 hours'
          AND pv."firstSeenAt" <= r.at
      ), fresh AS (
        SELECT r.* FROM discovery_ids d JOIN run_details r ON r.id = d.id
        ORDER BY r."createdAt" DESC, r.id DESC LIMIT 5
      ), selected AS MATERIALIZED (
        SELECT id, "createdAt", "workflowName", "jobRunType",
               bool_or(latest) AS latest, bool_or(fresh) AS fresh
        FROM (
          SELECT *, true AS latest, false AS fresh FROM latest
          UNION ALL
          SELECT *, false AS latest, true AS fresh FROM fresh
        ) candidates
        GROUP BY id, "createdAt", "workflowName", "jobRunType"
      )
      SELECT r.id, r."createdAt"::timestamptz AS "createdAt", r."workflowName",
             r."jobRunType", r.latest, r.fresh,
             (SELECT ${JOB_HISTORY_STATUS_SQL} FROM jobs job
                   WHERE job."jobHistoryId" = r.id) AS status
      FROM owned LEFT JOIN selected r ON true
      ORDER BY r."createdAt" DESC, r.id DESC`,
      [projectId, workspaceId, asOf ?? null],
    );
    if (rows.length === 0) throw new NotFoundException('Project not found');
    let lastRun: ProjectOverviewRun | null = null;
    const newVulnerabilityRuns: ProjectOverviewRun[] = [];
    for (const row of rows) {
      if (row.id === null) continue;
      const { latest, fresh, ...run } = row;
      if (latest) lastRun = run;
      if (fresh) newVulnerabilityRuns.push(run);
    }
    return { lastRun, newVulnerabilityRuns };
  }
}
