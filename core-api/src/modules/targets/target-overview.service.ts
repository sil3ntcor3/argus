import { CronSchedule, JobStatus } from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JOB_HISTORY_STATUS_SQL } from '../jobs-registry/job-history-status';
import {
  TargetInsightKind,
  TargetInsightLevel,
  type TargetOverviewDto,
} from './dto/target-overview.dto';
import { staleTargetCondition } from './stale-target-condition';
import { TARGET_RUN_CTES, TARGET_RUN_ORDER_SQL } from './target-run-sql';

const EXPOSURE_LIMIT = 6;
const RECENT_DISCOVERY_DAYS = 7;
const TLS_EXPIRY_DAYS = 30;

type TargetOverviewRow = Omit<TargetOverviewDto, 'insights'> & {
  scanSchedule: CronSchedule | null;
  stale: boolean;
  daysSinceDiscovery: number | null;
  expiringTlsServices: number;
  failedRunId: string | null;
};

@Injectable()
export class TargetOverviewService {
  constructor(private readonly dataSource: DataSource) {}

  async getOverview(
    id: string,
    workspaceId: string,
    canReadJobs = false,
  ): Promise<TargetOverviewDto> {
    // Scope the services once and count them independently from the assets.
    // HTTP observations follow the response's owning service.
    const [overview] = await this.dataSource.query<TargetOverviewRow[]>(
      `WITH owned AS (
         SELECT t.id, t."workspaceId", t."scanSchedule", ${staleTargetCondition('t')} AS stale,
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
       SELECT t."scanSchedule", t.stale, t."daysSinceDiscovery",
              CASE WHEN $3::boolean THEN (
                WITH ${TARGET_RUN_CTES}
                SELECT latest.id
                FROM (SELECT id FROM owned_runs ORDER BY ${TARGET_RUN_ORDER_SQL} LIMIT 1) latest
                WHERE (SELECT ${JOB_HISTORY_STATUS_SQL}
                       FROM jobs job WHERE job."jobHistoryId" = latest.id) = '${JobStatus.FAILED}'
              ) END AS "failedRunId",
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
      [id, workspaceId, canReadJobs],
    );
    if (!overview) throw new NotFoundException('Target not found');

    const {
      scanSchedule,
      stale,
      daysSinceDiscovery,
      expiringTlsServices,
      failedRunId,
      ...metrics
    } = overview;
    const insights: TargetOverviewDto['insights'] = [];
    if (failedRunId) {
      insights.push({
        kind: TargetInsightKind.LAST_RUN_FAILED,
        level: TargetInsightLevel.WARNING,
        runId: failedRunId,
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
    return { ...metrics, insights };
  }
}
