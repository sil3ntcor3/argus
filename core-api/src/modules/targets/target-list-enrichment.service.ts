import { CronSchedule, JobStatus, Severity } from '@/common/enums/enum';
import { openVulnerabilityCondition } from '@/modules/vulnerabilities/open-vulnerability';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { GetManyTargetResponseDto } from './dto/targets.dto';
import { TargetOverviewService } from './target-overview.service';
import { TARGET_ACTIVE_RUN_CONDITION_SQL } from './target-run-sql';

type Enrichment = Pick<
  GetManyTargetResponseDto,
  'openVulnerabilities' | 'scanProgress' | 'projects' | 'nextScanAt'
>;
type ReadRow = Omit<Enrichment, 'nextScanAt'> & {
  id: string;
  jobId: string | null;
  scanSchedule: CronSchedule | null;
};
export interface TargetListAccess {
  jobs: boolean;
  findings: boolean;
  projects: boolean;
}

const severityCounts = Object.values(Severity)
  .map(
    (severity) =>
      `'${severity}', COUNT(*) FILTER (WHERE v.severity='${severity}')::int`,
  )
  .join(',');

/** Page-only enrichment keeps the original list's grouping, order and totals intact. */
@Injectable()
export class TargetListEnrichmentService {
  constructor(
    private readonly db: DataSource,
    private readonly overview: TargetOverviewService,
  ) {}

  async enrich<T extends { id: string }>(
    rows: T[],
    workspaceId: string,
    access: TargetListAccess,
  ): Promise<(T & Enrichment)[]> {
    if (!rows.length) return [];
    const details = await this.db.query<ReadRow[]>(
      `WITH owned AS MATERIALIZED (
        SELECT id,"workspaceId","jobId","scanSchedule" FROM targets
        WHERE id=ANY($1::uuid[]) AND "workspaceId"=$2
      ), target_assets AS MATERIALIZED (
        SELECT a.id,a."targetId" FROM owned t JOIN assets a ON a."targetId"=t.id
      ), candidate_runs AS MATERIALIZED (
        SELECT DISTINCT job."jobHistoryId" AS id FROM jobs job
        JOIN target_assets a ON a.id=job."assetId"
        WHERE $4::boolean AND job."jobHistoryId" IS NOT NULL
      ), active_runs AS (
        SELECT h.id FROM candidate_runs candidate JOIN job_histories h ON h.id=candidate.id
        JOIN workflows w ON w.id=h."workflowId"
        WHERE w."workspaceId"=$2 AND ${TARGET_ACTIVE_RUN_CONDITION_SQL}
      ), progress AS (
        SELECT a."targetId",COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE job.status NOT IN ('${JobStatus.PENDING}','${JobStatus.IN_PROGRESS}'))::int AS done
        FROM jobs job JOIN active_runs h ON h.id=job."jobHistoryId"
        JOIN target_assets a ON a.id=job."assetId" GROUP BY a."targetId"
      )
      SELECT t.id,t."jobId",t."scanSchedule",
        CASE WHEN $3::boolean THEN (
          SELECT jsonb_build_object(${severityCounts})
          FROM target_assets a JOIN vulnerabilities v ON v."assetId"=a.id
          WHERE a."targetId"=t.id AND ${openVulnerabilityCondition('v')}
        ) END AS "openVulnerabilities",
        CASE WHEN $4::boolean AND stats.total>0 THEN jsonb_build_object('done',stats.done,'total',stats.total) END AS "scanProgress",
        CASE WHEN $5::boolean THEN COALESCE((
          SELECT jsonb_agg(project ORDER BY project.assets DESC,project.name,project.id) FROM (
            SELECT p.id,p.name,p."hexColor",COUNT(*)::int AS assets
            FROM target_assets a JOIN project_assets pa ON pa."assetId"=a.id
            JOIN projects p ON p.id=pa."projectId" AND p."workspaceId"=t."workspaceId"
            WHERE a."targetId"=t.id AND p."archivedAt" IS NULL
            GROUP BY p.id ORDER BY assets DESC,p.name,p.id LIMIT 6
          ) project
        ),'[]'::jsonb) END AS projects
      FROM owned t LEFT JOIN progress stats ON stats."targetId"=t.id`,
      [
        rows.map((row) => row.id),
        workspaceId,
        access.findings,
        access.jobs,
        access.projects,
      ],
    );
    const next = new Map<string, Date | null>();
    // Bound fan-out and stop admitting work after the page's lookup budget.
    // The shared reader bounds each Redis command and deduplicates pending keys.
    const deadline = performance.now() + 500;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, details.length) }, async () => {
        while (cursor < details.length && performance.now() < deadline) {
          const row = details[cursor++];
          try {
            next.set(
              row.id,
              await this.overview.getNextScanAt(
                row.id,
                row.jobId,
                row.scanSchedule,
              ),
            );
          } catch {
            next.set(row.id, null);
          }
        }
      }),
    );
    const byId = new Map(details.map((row) => [row.id, row]));
    return rows.map((row) => {
      const detail = byId.get(row.id);
      return {
        ...row,
        openVulnerabilities: access.findings
          ? (detail?.openVulnerabilities ?? null)
          : null,
        scanProgress: access.jobs ? (detail?.scanProgress ?? null) : null,
        projects: access.projects ? (detail?.projects ?? null) : null,
        nextScanAt: next.get(row.id) ?? null,
      };
    });
  }
}
