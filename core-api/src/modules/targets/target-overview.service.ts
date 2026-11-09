import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TargetOverviewDto } from './dto/target-overview.dto';

const EXPOSURE_LIMIT = 6;

@Injectable()
export class TargetOverviewService {
  constructor(private readonly dataSource: DataSource) {}

  async getOverview(
    id: string,
    workspaceId: string,
  ): Promise<TargetOverviewDto> {
    // Scope the services once and count them independently from the assets.
    // HTTP observations follow the response's owning service.
    const [overview] = await this.dataSource.query<TargetOverviewDto[]>(
      `WITH owned AS (
         SELECT t.id FROM targets t WHERE t.id = $1 AND t."workspaceId" = $2
       ), target_services AS MATERIALIZED (
         SELECT s.id, s.port, s."createdAt"
         FROM owned t JOIN assets a ON a."targetId" = t.id
         JOIN asset_services s ON s."assetId" = a.id
       ), target_responses AS MATERIALIZED (
         SELECT r.id, s.id AS "serviceId"
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
       )
       SELECT asset_counts.*, service_counts.*, jsonb_build_object(
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
                    BETWEEN LOCALTIMESTAMP - INTERVAL '7 days' AND LOCALTIMESTAMP)::int AS "newAssets"
             FROM assets a WHERE a."targetId" = t.id
         ) asset_counts
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::int AS "totalServices",
                  COUNT(*) FILTER (WHERE s."createdAt"
                    BETWEEN LOCALTIMESTAMP - INTERVAL '7 days' AND LOCALTIMESTAMP)::int AS "newServices",
                  COUNT(DISTINCT s.port)::int AS "openPorts"
             FROM target_services s
         ) service_counts`,
      [id, workspaceId],
    );
    if (!overview) throw new NotFoundException('Target not found');
    return overview;
  }
}
