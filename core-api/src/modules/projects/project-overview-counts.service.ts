import { Severity } from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { openVulnerabilityCondition } from '../vulnerabilities/open-vulnerability';

type SeverityCounts = Record<Severity, number>;

interface ProjectOverviewCounts {
  totalAssets: number;
  newAssets: number;
  workflows: number;
  openVulnerabilities: SeverityCounts;
  newVulnerabilities: number;
  weekly: (SeverityCounts & { week: string })[];
}

const severities = Object.values(Severity);
const nonInfoSeverities = severities
  .filter((s) => s !== Severity.INFO)
  .map((s) => `'${s}'`)
  .join(', ');
const openCounts = severities.map((s) => {
  // The open totals treat unrecognized worker severities as informational.
  const bucket =
    s === Severity.INFO
      ? `COALESCE(severity NOT IN (${nonInfoSeverities}), true)`
      : `severity = '${s}'`;
  return `'${s}', COUNT(*) FILTER (WHERE "isOpen" AND ${bucket})::int`;
});
const weeklyCounts = severities.map(
  (s) => `COUNT(*) FILTER (WHERE severity = '${s}')::int AS ${s}`,
);
const weeklyFields = severities.map((s) => `'${s}', COALESCE(w.${s}, 0)`);

@Injectable()
export class ProjectOverviewCountsService {
  constructor(private readonly dataSource: DataSource) {}

  async read(
    projectId: string,
    workspaceId: string,
    asOf?: Date,
    executor: Pick<DataSource, 'query'> = this.dataSource,
  ): Promise<ProjectOverviewCounts> {
    const [overview] = await executor.query<ProjectOverviewCounts[]>(
      `WITH owned AS (
        SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2
      ), reference_time AS (
        SELECT COALESCE($3::timestamptz, now()) AS at
      ), bounds AS (
        -- Membership timestamps are stored in the database's local wall clock.
        SELECT at, at::timestamp AS local_at,
               (at - interval '168 hours')::timestamp AS local_cutoff,
               date_trunc('week', at AT TIME ZONE 'UTC') AS monday
        FROM reference_time
      ), findings AS MATERIALIZED (
        -- Keep historical findings even when their asset was removed from project scope.
        SELECT v.severity, pv."firstSeenAt", ${openVulnerabilityCondition('v')} AS "isOpen"
        FROM owned p JOIN project_vulnerabilities pv ON pv."projectId" = p.id
        JOIN LATERAL (
          SELECT v.id, v.severity, v."isArchived", v."detectionStatus", v."reviewStatus"
          FROM vulnerabilities v JOIN assets a ON a.id = v."assetId"
          JOIN targets t ON t.id = a."targetId" AND t."workspaceId" = $2
          WHERE v.id = pv."vulnerabilityId" AND v."reviewStatus"='approved'
          OFFSET 0
        ) v ON true
      ), finding_totals AS (
        SELECT jsonb_build_object(${openCounts.join(', ')}) AS "openVulnerabilities",
               COUNT(*) FILTER (WHERE "isOpen" AND "firstSeenAt" > at - interval '168 hours'
                                AND "firstSeenAt" <= at)::int AS "newVulnerabilities"
        FROM findings CROSS JOIN bounds
      ), week_counts AS (
        SELECT date_trunc('week', "firstSeenAt" AT TIME ZONE 'UTC') AS week, ${weeklyCounts.join(', ')}
        FROM findings CROSS JOIN bounds
        WHERE "firstSeenAt" >= ((monday - interval '7 weeks') AT TIME ZONE 'UTC')
          AND "firstSeenAt" <= at
        GROUP BY 1
      )
      SELECT assets.*, bindings.workflows, totals.*, history.weekly
      FROM owned p CROSS JOIN bounds b CROSS JOIN finding_totals totals
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS "totalAssets",
               COUNT(*) FILTER (WHERE pa."createdAt" > b.local_cutoff
                                AND pa."createdAt" <= b.local_at)::int AS "newAssets"
        FROM project_assets pa JOIN assets a ON a.id = pa."assetId"
        JOIN targets t ON t.id = a."targetId" AND t."workspaceId" = $2
        WHERE pa."projectId" = p.id
      ) assets
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS workflows
        FROM project_workflows pw JOIN workflows w ON w.id = pw."workflowId" AND w."workspaceId" = $2
        WHERE pw."projectId" = p.id
      ) bindings
      CROSS JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('week', to_char(s.week, 'YYYY-MM-DD'),
                         ${weeklyFields.join(', ')}) ORDER BY s.week) AS weekly
        FROM generate_series(b.monday - interval '7 weeks', b.monday, interval '1 week') s(week)
        LEFT JOIN week_counts w ON w.week = s.week
      ) history`,
      [projectId, workspaceId, asOf ?? null],
    );
    if (!overview) throw new NotFoundException('Project not found');
    return overview;
  }
}
