import { Severity } from '@/common/enums/enum';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  FindingSearchResultDto,
  SearchAssetsTargetsDto,
} from './dto/search.dto';

/** Bounded finding previews, independent of the legacy target/asset page. */
@Injectable()
export class FindingSearchService {
  constructor(private readonly db: DataSource) {}

  /** Match approved workspace findings without returning their private payloads. */
  async search(
    query: SearchAssetsTargetsDto,
    workspaceId: string,
  ): Promise<FindingSearchResultDto[]> {
    const term = query.value.trim();
    if (!term && !query.severity?.length) return [];
    const severities = query.severity?.length
      ? [...new Set(query.severity)]
      : Object.values(Severity);
    const pattern = term ? '%' + term.replace(/[\\%_]/g, '\\$&') + '%' : null;
    const rows = await this.db.query<FindingSearchResultDto[]>(
      `SELECT v.id, v.name, v.severity, v."affectedUrl",
              jsonb_build_object('id', a.id, 'value', a.value) AS asset
       FROM vulnerabilities v JOIN assets a ON a.id = v."assetId"
       JOIN targets t ON t.id = a."targetId"
       WHERE t."workspaceId" = $1 AND v."reviewStatus" = 'approved'
         AND v.severity = ANY($2::varchar[])
         AND ($3::text IS NULL OR v.name ILIKE $3 OR v."affectedUrl" ILIKE $3
              OR EXISTS (SELECT 1 FROM unnest(COALESCE(v."cveId", '{}'::text[])) cve WHERE cve ILIKE $3))
       ORDER BY v."createdAt" DESC, v.id DESC LIMIT 5`,
      [workspaceId, severities, pattern],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      severity: row.severity,
      affectedUrl: row.affectedUrl,
      asset: { id: row.asset.id, value: row.asset.value },
    }));
  }
}
