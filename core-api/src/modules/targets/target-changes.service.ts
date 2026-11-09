import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  type GetTargetChangesQueryDto,
  type TargetChangeDto,
  TargetChangeKind,
} from './dto/target-changes.dto';

type CountedChange = Omit<TargetChangeDto, 'id'> & {
  id: string | null;
  total: number;
};

@Injectable()
export class TargetChangesService {
  constructor(private readonly dataSource: DataSource) {}

  async list(id: string, workspaceId: string, query: GetTargetChangesQueryDto) {
    const { page, limit, kind } = query;
    const offset = (page - 1) * limit;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset)
    ) {
      throw new BadRequestException('Invalid target changes pagination');
    }

    // Page scoped discovery IDs before looking up labels. A single snapshot
    // supplies the total even when the requested page has no rows.
    const rows = await this.dataSource.query<CountedChange[]>(
      `WITH owned AS (
         SELECT id FROM targets WHERE id = $1 AND "workspaceId" = $2
       ), target_assets AS MATERIALIZED (
         SELECT a.id, a."createdAt", a."isPrimary"
         FROM assets a JOIN owned t ON a."targetId" = t.id
       ), matching AS MATERIALIZED (
         SELECT '${TargetChangeKind.ASSET}' AS kind, a."createdAt" AS at,
                a.id, a.id AS "assetId"
         FROM target_assets a
         WHERE NOT a."isPrimary" AND ($3::text IS NULL OR $3 = '${TargetChangeKind.ASSET}')
         UNION ALL
         SELECT '${TargetChangeKind.SERVICE}', s."createdAt", s.id, a.id
         FROM target_assets a JOIN asset_services s ON s."assetId" = a.id
         WHERE $3::text IS NULL OR $3 = '${TargetChangeKind.SERVICE}'
       ), page AS (
         SELECT * FROM matching ORDER BY at DESC, kind, id LIMIT $4 OFFSET $5
       )
       SELECT totals.total, p.id, p.kind, p.at,
              CASE WHEN p.kind = '${TargetChangeKind.ASSET}' THEN a.value ELSE s.value END AS label,
              CASE WHEN p.kind = '${TargetChangeKind.SERVICE}' THEN a.value END AS "assetValue"
       FROM owned CROSS JOIN (SELECT COUNT(*)::int AS total FROM matching) totals
       LEFT JOIN page p ON true
       LEFT JOIN assets a ON a.id = p."assetId"
       LEFT JOIN asset_services s ON p.kind = '${TargetChangeKind.SERVICE}' AND s.id = p.id
       ORDER BY p.at DESC, p.kind, p.id`,
      [id, workspaceId, kind ?? null, limit, offset],
    );
    if (!rows.length) throw new NotFoundException('Target not found');

    const [{ total }] = rows;
    const data = rows.flatMap(({ id, total: _total, ...change }) =>
      id === null ? [] : [{ id, ...change }],
    );
    return getManyResponse({ query: { ...query, sortBy: 'at' }, data, total });
  }
}
