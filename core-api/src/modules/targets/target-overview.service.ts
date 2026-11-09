import { setTimeout as delay } from 'node:timers/promises';
import { BullMQName, CronSchedule, JobStatus } from '@/common/enums/enum';
import { openVulnerabilityCondition } from '@/modules/vulnerabilities/open-vulnerability';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { JobScheduler } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  TargetInsightKind,
  TargetInsightLevel,
  type TargetOverviewDto,
} from './dto/target-overview.dto';
import type { TargetRunDto } from './dto/target-runs.dto';
import { staleTargetCondition } from './stale-target-condition';
import {
  TARGET_RUN_COUNTS_SQL,
  TARGET_RUN_CTES,
  TARGET_RUN_FIELDS_SQL,
  TARGET_RUN_ORDER_SQL,
  TARGET_RUN_STATUS_SQL,
} from './target-run-sql';

const EXPOSURE_LIMIT = 6;
const RECENT_DISCOVERY_DAYS = 7;
const TLS_EXPIRY_DAYS = 30;
const SCHEDULE_LOOKUP_TIMEOUT_MS = 500;
const MAX_PENDING_SCHEDULE_LOOKUPS = 16;

type ScheduleReader = Pick<JobScheduler, 'getScheduler'>;
type ScheduleLookup = ReturnType<ScheduleReader['getScheduler']>;

type FindingCounts = Pick<
  TargetOverviewDto,
  'openVulnerabilities' | 'newVulnerabilities'
>;

type TargetOverviewRow = Omit<
  TargetOverviewDto,
  'insights' | 'nextScanAt' | 'lastRun' | keyof FindingCounts
> & {
  jobId: string | null;
  scanSchedule: CronSchedule | null;
  stale: boolean;
  daysSinceDiscovery: number | null;
  expiringTlsServices: number;
  lastRun:
    | (Omit<TargetRunDto, 'createdAt' | 'updatedAt'> & {
        createdAt: string;
        updatedAt: string;
      })
    | null;
  findings: FindingCounts | null;
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
    access: { jobs: boolean; findings: boolean },
  ): Promise<TargetOverviewDto> {
    // Scope the services once and count them independently from the assets.
    // HTTP observations follow the response's owning service.
    const [overview] = await this.dataSource.query<TargetOverviewRow[]>(
      `WITH owned AS (
         SELECT t.id, t."workspaceId", t."scanSchedule", t."jobId", ${staleTargetCondition('t')} AS stale,
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
                WITH ${TARGET_RUN_CTES}
                SELECT row_to_json(run)
                FROM (
                  SELECT p.*, stats.*, ${TARGET_RUN_STATUS_SQL} AS status
                  FROM (
                    SELECT ${TARGET_RUN_FIELDS_SQL}
                    FROM owned_runs h ORDER BY ${TARGET_RUN_ORDER_SQL} LIMIT 1
                  ) p
                  CROSS JOIN LATERAL (${TARGET_RUN_COUNTS_SQL}) stats
                ) run
              ) END AS "lastRun",
              CASE WHEN $4::boolean THEN (
                SELECT jsonb_build_object(
                  'openVulnerabilities', jsonb_build_object(
                    'critical', COUNT(*) FILTER (WHERE v.severity = 'critical'),
                    'high', COUNT(*) FILTER (WHERE v.severity = 'high'),
                    'medium', COUNT(*) FILTER (WHERE v.severity = 'medium'),
                    'low', COUNT(*) FILTER (WHERE v.severity = 'low'),
                    'info', COUNT(*) FILTER (WHERE v.severity = 'info')
                  ),
                  'newVulnerabilities', COUNT(*) FILTER (WHERE v."createdAt"
                    BETWEEN LOCALTIMESTAMP - INTERVAL '${RECENT_DISCOVERY_DAYS} days' AND LOCALTIMESTAMP)
                )
                FROM assets a JOIN vulnerabilities v ON v."assetId" = a.id
                WHERE a."targetId" = t.id AND ${openVulnerabilityCondition('v')}
              ) END AS findings,
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
      [id, workspaceId, access.jobs, access.findings],
    );
    if (!overview) throw new NotFoundException('Target not found');

    const {
      jobId,
      scanSchedule,
      stale,
      daysSinceDiscovery,
      expiringTlsServices,
      lastRun: run,
      findings,
      ...metrics
    } = overview;
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
      nextScanAt: await this.getNextScanAt(id, jobId, scanSchedule),
      lastRun: run
        ? {
            ...run,
            createdAt: new Date(run.createdAt),
            updatedAt: new Date(run.updatedAt),
          }
        : null,
      openVulnerabilities: findings?.openVulnerabilities ?? null,
      newVulnerabilities: findings?.newVulnerabilities ?? null,
      insights,
    };
  }
}
