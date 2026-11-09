import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TargetOverviewDto } from './dto/target-overview.dto';

@Injectable()
export class TargetOverviewService {
  constructor(private readonly dataSource: DataSource) {}

  async getOverview(
    id: string,
    workspaceId: string,
  ): Promise<TargetOverviewDto> {
    // Separate aggregates avoid multiplying asset counts by their services.
    // Both aggregates derive from the same workspace-scoped target row.
    const [overview] = await this.dataSource.query<TargetOverviewDto[]>(
      `SELECT asset_counts.*, service_counts.*
         FROM targets t
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
             FROM assets a JOIN asset_services s ON s."assetId" = a.id
            WHERE a."targetId" = t.id
         ) service_counts
        WHERE t.id = $1 AND t."workspaceId" = $2`,
      [id, workspaceId],
    );
    if (!overview) throw new NotFoundException('Target not found');
    return overview;
  }
}
