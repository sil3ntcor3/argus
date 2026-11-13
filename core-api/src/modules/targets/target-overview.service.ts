import { setTimeout as delay } from 'node:timers/promises';
import {
  BullMQName,
  CronSchedule,
  JobStatus,
  Severity,
} from '@/common/enums/enum';
import { openVulnerabilityCondition } from '@/modules/vulnerabilities/open-vulnerability';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { JobScheduler } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  TargetInsightKind,
  TargetInsightLevel,
  type TargetOverviewDto,
  type TargetTopVulnerabilityDto,
  type TargetIssueRefDto,
} from './dto/target-overview.dto';
import type { TargetRunDto } from './dto/target-runs.dto';
import { staleTargetCondition } from './stale-target-condition';
import {
  TARGET_ACTIVE_RUN_CONDITION_SQL,
  TARGET_RUN_CTES,
  TARGET_RUN_FIELDS_SQL,
  TARGET_RUN_ORDER_SQL,
  TARGET_RUN_PROGRESS_SQL,
  TARGET_RUN_PROJECT_SQL,
  TARGET_RUN_STATUS_SQL,
} from './target-run-sql';

const EXPOSURE_LIMIT = 6;
const ACTIVE_RUN_LIMIT = 5;
const TOP_FINDING_LIMIT = 5;
const PROJECT_LIMIT = 6;
const TOP_FINDING_ORDER_SQL =
  'f.severity_rank DESC, f."createdAt" DESC, f.id DESC';
const FINDING_WEEK_COUNT = 8;
const WEEKLY_COUNT_COLUMNS_SQL = Object.values(Severity)
  .map(
    (severity) =>
      `COUNT(*) FILTER (WHERE v.severity = '${severity}')::int AS ${severity}`,
  )
  .join(', ');
const WEEKLY_OUTPUT_FIELDS_SQL = Object.values(Severity)
  .map((severity) => `'${severity}', COALESCE(w.${severity}, 0)`)
  .join(', ');
const RECENT_DISCOVERY_DAYS = 7;
const TLS_EXPIRY_DAYS = 30;
const SCHEDULE_LOOKUP_TIMEOUT_MS = 500;
const MAX_PENDING_SCHEDULE_LOOKUPS = 16;

type ScheduleReader = Pick<JobScheduler, 'getScheduler'>;
type ScheduleLookup = ReturnType<ScheduleReader['getScheduler']>;

type FindingCounts = Pick<
  TargetOverviewDto,
  'openVulnerabilities' | 'newVulnerabilities' | 'weekly'
>;

type TopFindingJson = Omit<TargetTopVulnerabilityDto, 'createdAt'> & {
  createdAt: string;
};

type TargetRunJson = Omit<TargetRunDto, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

function toTargetRunDto(run: TargetRunJson): TargetRunDto {
  return {
    ...run,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

type TargetOverviewRow = Omit<
  TargetOverviewDto,
  | 'insights'
  | 'issues'
  | 'nextScanAt'
  | 'lastRun'
  | 'activeRuns'
  | 'topVulnerabilities'
  | keyof FindingCounts
> & {
  jobId: string | null;
  scanSchedule: CronSchedule | null;
  stale: boolean;
  daysSinceDiscovery: number | null;
  expiringTlsServices: number;
  runs: { lastRun: TargetRunJson | null; activeRuns: TargetRunJson[] } | null;
  findings: (FindingCounts & { topVulnerabilities: TopFindingJson[] }) | null;
};

@Injectable()
export class TargetOverviewService {
  private readonly pendingSchedules = new Map<string, ScheduleLookup>();
  private scheduleReader?: Promise<ScheduleReader>;

  constructor(
    private readonly dataSource: DataSource,
    @InjectQueue(BullMQName.ASSETS_DISCOVERY_SCHEDULE)
    private readonly scanScheduleQueue: {
      client: Promise<{ status: string }>;
      jobScheduler: Promise<ScheduleReader>;
    },
  ) {}

  /** Bounds Redis commands that can outlive an individual request's deadline. */
  private readSchedule(jobId: string): ScheduleLookup | undefined {
    const pending = this.pendingSchedules.get(jobId);
    if (pending || this.pendingSchedules.size >= MAX_PENDING_SCHEDULE_LOOKUPS)
      return pending;

    const lookup = (async () => {
      try {
        const client = await this.scanScheduleQueue.client;
        if (client.status !== 'ready') return undefined;
        const reader = await (this.scheduleReader ??=
          this.scanScheduleQueue.jobScheduler);
        return await reader.getScheduler(jobId);
      } catch {
        return undefined;
      }
    })().finally(() => this.pendingSchedules.delete(jobId));
    const deadline = new AbortController();
    const timedLookup = Promise.race([
      lookup,
      delay(SCHEDULE_LOOKUP_TIMEOUT_MS, undefined, {
        signal: deadline.signal,
      }),
    ]).finally(() => deadline.abort());
    this.pendingSchedules.set(jobId, timedLookup);
    return timedLookup;
  }

  /** Reads the saved schedule without letting Redis delays block Overview. */
  private async getNextScanAt(
    id: string,
    jobId: string | null,
    scanSchedule: CronSchedule | null,
  ): Promise<Date | null> {
    if (!jobId || !scanSchedule || scanSchedule === CronSchedule.DISABLED)
      return null;
    const schedule = await this.readSchedule(jobId);
    if (
      !schedule?.next ||
      schedule.name !== id.toLowerCase() ||
      schedule.pattern !== scanSchedule
    ) {
      return null;
    }
    const nextScanAt = new Date(schedule.next);
    return Number.isNaN(nextScanAt.getTime()) ? null : nextScanAt;
  }

  async getOverview(
    id: string,
    workspaceId: string,
    access: { jobs: boolean; findings: boolean; projects: boolean; issues?: boolean },
  ): Promise<TargetOverviewDto> {
    const now = new Date();
    const monday = new Date(now);
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    // Bind Date values so the driver encodes the UTC boundaries using the same
    // local wall clock it uses for the legacy timestamp-without-zone column.
    const weekStarts = Array.from({ length: FINDING_WEEK_COUNT }, (_, index) => {
      const week = new Date(monday);
      week.setUTCDate(monday.getUTCDate() - (FINDING_WEEK_COUNT - 1 - index) * 7);
      return week;
    });
    // Scope the services once and count them independently from the assets.
    // HTTP observations follow the response's owning service.
    const [overview] = await this.dataSource.query<TargetOverviewRow[]>(
      `WITH owned AS (
         SELECT t.id, t."workspaceId", t."scanSchedule", t."jobId", $8::boolean AS "canReadProjects",
                $4::boolean AS "canReadFindings",
                ${staleTargetCondition('t')} AS stale,
                EXTRACT(DAY FROM LOCALTIMESTAMP - t."lastDiscoveredAt")::int AS "daysSinceDiscovery"
         FROM targets t WHERE t.id = $1 AND t."workspaceId" = $2
       ), target_services AS MATERIALIZED (
         SELECT s.id, s.port, s."createdAt"
         FROM owned t JOIN assets a ON a."targetId" = t.id
         JOIN asset_services s ON s."assetId" = a.id
       ), target_responses AS MATERIALIZED (
         SELECT r.id, s.id AS "serviceId", r."createdAt"
         FROM target_services s JOIN http_responses r ON r."assetServiceId" = s.id
       ), top_ports AS (
         SELECT port, COUNT(*)::int AS count FROM target_services
         GROUP BY port ORDER BY count DESC, port LIMIT ${EXPOSURE_LIMIT}
       ), top_technologies AS (
         SELECT h.name, COUNT(DISTINCT r."serviceId")::int AS count
         FROM target_responses r JOIN http_response_technologies h ON h."httpResponseId" = r.id
         GROUP BY h.name ORDER BY count DESC, h.name LIMIT ${EXPOSURE_LIMIT}
       ), top_status_codes AS (
         SELECT h."statusCode", COUNT(DISTINCT r."serviceId")::int AS count
         FROM target_responses r JOIN http_status_codes h ON h."httpResponseId" = r.id
         WHERE h."isPrimary" AND h."statusCode" > 0
         GROUP BY h."statusCode" ORDER BY count DESC, h."statusCode" LIMIT ${EXPOSURE_LIMIT}
       ), latest_certificates AS (
         SELECT DISTINCT ON (r."serviceId") r."serviceId", c."notAfter"
         FROM target_responses r JOIN tls_certificates c ON c."httpResponseId" = r.id
         WHERE c."notAfter" IS NOT NULL
         ORDER BY r."serviceId", r."createdAt" DESC, r.id DESC
       )
       SELECT t."scanSchedule", t."jobId", t.stale, t."daysSinceDiscovery",
              CASE WHEN $3::boolean THEN (
                WITH ${TARGET_RUN_CTES},
                latest AS (
                  SELECT ${TARGET_RUN_FIELDS_SQL}
                  FROM owned_runs h ORDER BY ${TARGET_RUN_ORDER_SQL} LIMIT 1
                ), active AS (
                  SELECT ${TARGET_RUN_FIELDS_SQL}
                  FROM owned_runs h WHERE ${TARGET_ACTIVE_RUN_CONDITION_SQL}
                  ORDER BY ${TARGET_RUN_ORDER_SQL} LIMIT ${ACTIVE_RUN_LIMIT}
                ), run_rows AS (
                  SELECT p.*, stats.*, project.*, ${TARGET_RUN_STATUS_SQL} AS status
                  FROM (SELECT * FROM latest UNION SELECT * FROM active) p
                  CROSS JOIN LATERAL (${TARGET_RUN_PROGRESS_SQL}) stats
                  LEFT JOIN LATERAL (${TARGET_RUN_PROJECT_SQL}) project ON true
                )
                SELECT json_build_object(
                  'lastRun', (SELECT row_to_json(r) FROM run_rows r
                              WHERE r.id IN (SELECT id FROM latest)),
                  'activeRuns', COALESCE(
                    (SELECT json_agg(r ORDER BY ${TARGET_RUN_ORDER_SQL})
                     FROM run_rows r WHERE r.id IN (SELECT id FROM active)),
                    '[]'::json
                  )
                )
              ) END AS runs,
              CASE WHEN $4::boolean THEN (
                WITH open_findings AS MATERIALIZED (
                  SELECT v.id, v.severity, COALESCE(v."firstDetectedDate",v."createdAt") AS "createdAt",
                         CASE v.severity
                           WHEN '${Severity.CRITICAL}' THEN 5 WHEN '${Severity.HIGH}' THEN 4
                           WHEN '${Severity.MEDIUM}' THEN 3 WHEN '${Severity.LOW}' THEN 2
                           WHEN '${Severity.INFO}' THEN 1
                         END AS severity_rank
                  FROM assets a JOIN vulnerabilities v ON v."assetId" = a.id
                  WHERE a."targetId" = t.id AND ${openVulnerabilityCondition('v')}
                ), week_counts AS (
                  SELECT width_bucket(COALESCE(v."firstDetectedDate",v."createdAt")::timestamp, $5::timestamp[]) AS week_number,
                         ${WEEKLY_COUNT_COLUMNS_SQL}
                  FROM assets a JOIN vulnerabilities v ON v."assetId" = a.id
                  WHERE a."targetId" = t.id AND v."reviewStatus"='approved'
                    AND COALESCE(v."firstDetectedDate",v."createdAt")::timestamp BETWEEN ($5::timestamp[])[1] AND $6::timestamp
                  GROUP BY 1
                )
                SELECT jsonb_build_object(
                  'openVulnerabilities', jsonb_build_object(
                    'critical', COUNT(*) FILTER (WHERE severity = 'critical'),
                    'high', COUNT(*) FILTER (WHERE severity = 'high'),
                    'medium', COUNT(*) FILTER (WHERE severity = 'medium'),
                    'low', COUNT(*) FILTER (WHERE severity = 'low'),
                    'info', COUNT(*) FILTER (WHERE severity = 'info')
                  ),
                  'newVulnerabilities', COUNT(*) FILTER (WHERE "createdAt"
                    BETWEEN LOCALTIMESTAMP - INTERVAL '${RECENT_DISCOVERY_DAYS} days' AND LOCALTIMESTAMP),
                  'weekly', (
                    SELECT jsonb_agg(jsonb_build_object('week', s.week,
                                      ${WEEKLY_OUTPUT_FIELDS_SQL}) ORDER BY s.week_number)
                    FROM unnest($7::text[]) WITH ORDINALITY s(week, week_number)
                    LEFT JOIN week_counts w USING (week_number)
                  ),
                  'topVulnerabilities', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', f.id, 'name', v.name, 'severity', f.severity, 'assetValue', a.value,
                      'cveId', array_remove(v."cveId", NULL::text), 'createdAt', f."createdAt"
                    ) ORDER BY ${TOP_FINDING_ORDER_SQL})
                    FROM (
                      SELECT * FROM open_findings f
                      WHERE f.severity_rank IS NOT NULL
                      ORDER BY ${TOP_FINDING_ORDER_SQL} LIMIT ${TOP_FINDING_LIMIT}
                    ) f
                    JOIN vulnerabilities v ON v.id = f.id
                    JOIN assets a ON a.id = v."assetId"
                  ), '[]'::jsonb)
                )
                FROM open_findings
              ) END AS findings,
              CASE WHEN $8::boolean THEN COALESCE((
                SELECT jsonb_agg(project ORDER BY project.assets DESC, project.name, project.id)
                FROM (
                  SELECT p.id, p.name, p."hexColor", COUNT(*)::int AS assets
                  FROM assets a JOIN project_assets pa ON pa."assetId" = a.id
                  JOIN projects p ON p.id = pa."projectId" AND p."workspaceId" = t."workspaceId"
                  WHERE a."targetId" = t.id AND p."archivedAt" IS NULL
                  GROUP BY p.id ORDER BY assets DESC, p.name, p.id LIMIT ${PROJECT_LIMIT}
                ) project
              ), '[]'::jsonb) END AS projects,
              (SELECT COUNT(*)::int FROM latest_certificates
               WHERE "notAfter" <= CURRENT_TIMESTAMP + INTERVAL '${TLS_EXPIRY_DAYS} days'
              ) AS "expiringTlsServices",
              asset_counts.*, service_counts.*, jsonb_build_object(
         'ports', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', port::text, 'count', count)
           ORDER BY count DESC, port) FROM top_ports), '[]'::jsonb),
         'technologies', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'count', count)
           ORDER BY count DESC, name) FROM top_technologies), '[]'::jsonb),
         'statusCodes', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', "statusCode"::text, 'count', count)
           ORDER BY count DESC, "statusCode") FROM top_status_codes), '[]'::jsonb)
       ) AS exposure
         FROM owned t
         CROSS JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE a."isEnabled")::int AS "totalAssets",
                  COUNT(*) FILTER (WHERE a."isEnabled" AND a."createdAt"
                    BETWEEN LOCALTIMESTAMP - INTERVAL '${RECENT_DISCOVERY_DAYS} days' AND LOCALTIMESTAMP)::int AS "newAssets"
             FROM assets a WHERE a."targetId" = t.id
         ) asset_counts
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::int AS "totalServices",
                  COUNT(*) FILTER (WHERE s."createdAt"
                    BETWEEN LOCALTIMESTAMP - INTERVAL '${RECENT_DISCOVERY_DAYS} days' AND LOCALTIMESTAMP)::int AS "newServices",
                  COUNT(DISTINCT s.port)::int AS "openPorts"
             FROM target_services s
         ) service_counts`,
      [
        id,
        workspaceId,
        access.jobs,
        access.findings,
        weekStarts,
        now,
        weekStarts.map((week) => week.toISOString().slice(0, 10)),
        access.projects,
      ],
    );
    if (!overview) throw new NotFoundException('Target not found');
    const issues = access.issues ? await this.dataSource.query<TargetIssueRefDto[]>(`SELECT issue.id,issue.no,issue.status,issue.priority,
      CASE WHEN NOT $3::boolean AND issue.type='vulnerability_remediation'
        AND (issue."ruleId" IS NOT NULL OR issue."groupKey" IS NOT NULL OR issue."sourceType" IS NOT NULL)
        THEN 'Remediation issue #' || issue.no::text ELSE issue.title END AS title
      FROM issues issue WHERE issue."workspaceId"=$2 AND issue.status IN ('open','in_progress')
      AND EXISTS (SELECT 1 FROM issue_links link WHERE link."issueId"=issue.id AND (
        (link."resourceType"='target' AND link."resourceId"=$1) OR
        (link."resourceType"='asset' AND EXISTS(SELECT 1 FROM assets a WHERE a.id=link."resourceId" AND a."targetId"=$1)) OR
        ($3::boolean AND link."resourceType"='vulnerability' AND EXISTS(
          SELECT 1 FROM vulnerabilities v JOIN assets a ON a.id=v."assetId" WHERE v.id=link."resourceId" AND a."targetId"=$1))))
      ORDER BY issue."createdAt" DESC,issue.id DESC LIMIT 5`, [id,workspaceId,access.findings]) : [];


    const {
      jobId,
      scanSchedule,
      stale,
      daysSinceDiscovery,
      expiringTlsServices,
      runs,
      findings,
      ...metrics
    } = overview;
    const run = runs?.lastRun;
    const insights: TargetOverviewDto['insights'] = [];
    const openCritical = findings?.openVulnerabilities?.critical ?? 0;
    if (openCritical > 0) {
      insights.push({
        kind: TargetInsightKind.CRITICAL_OPEN,
        level: TargetInsightLevel.CRITICAL,
        count: openCritical,
      });
    }
    if (run?.status === JobStatus.FAILED) {
      insights.push({
        kind: TargetInsightKind.LAST_RUN_FAILED,
        level: TargetInsightLevel.WARNING,
        runId: run.id,
      });
    }
    if (expiringTlsServices > 0) {
      insights.push({
        kind: TargetInsightKind.TLS_EXPIRING,
        level: TargetInsightLevel.WARNING,
        count: expiringTlsServices,
        days: TLS_EXPIRY_DAYS,
      });
    }
    if (stale) {
      insights.push({
        kind: TargetInsightKind.STALE_SCAN,
        level: TargetInsightLevel.WARNING,
        ...(daysSinceDiscovery === null ? {} : { days: daysSinceDiscovery }),
      });
    }
    if (metrics.newAssets > 0) {
      insights.push({
        kind: TargetInsightKind.NEW_ASSETS,
        level: TargetInsightLevel.INFO,
        count: metrics.newAssets,
        days: RECENT_DISCOVERY_DAYS,
      });
    }
    if (!scanSchedule || scanSchedule === CronSchedule.DISABLED) {
      insights.push({
        kind: TargetInsightKind.NO_SCHEDULE,
        level: TargetInsightLevel.INFO,
      });
    }
    return {
      ...metrics,
      issues,
      nextScanAt: await this.getNextScanAt(id, jobId, scanSchedule),
      lastRun: run ? toTargetRunDto(run) : null,
      activeRuns: runs?.activeRuns.map(toTargetRunDto) ?? null,
      openVulnerabilities: findings?.openVulnerabilities ?? null,
      newVulnerabilities: findings?.newVulnerabilities ?? null,
      weekly: findings?.weekly ?? null,
      topVulnerabilities:
        findings?.topVulnerabilities.map((finding) => ({
          ...finding,
          createdAt: new Date(finding.createdAt),
        })) ?? null,
      insights,
    };
  }
}
