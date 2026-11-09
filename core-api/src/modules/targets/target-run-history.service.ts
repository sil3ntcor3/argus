import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  GetTargetRunsQueryDto,
  TargetRunDto,
} from './dto/target-runs.dto';
import {
  TARGET_ACTIVE_RUN_CONDITION_SQL,
  TARGET_RUN_CTES,
  TARGET_RUN_FIELDS_SQL,
  TARGET_RUN_ORDER_SQL,
  TARGET_RUN_PROGRESS_SQL,
  TARGET_RUN_STATUS_SQL,
} from './target-run-sql';

type CountedRun = Omit<TargetRunDto, 'id'> & {
  id: string | null;
  total: number;
};

@Injectable()
export class TargetRunHistoryService {
  constructor(private readonly dataSource: DataSource) {}

  /** Pages owned runs before rolling up status and target-specific progress. */
  async list(id: string, workspaceId: string, query: GetTargetRunsQueryDto) {
    const { page, limit, active = false } = query;
    const offset = (page - 1) * limit;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset)
    ) {
      throw new BadRequestException('Invalid target run pagination');
    }

    // Ownership, total and page share one snapshot, including an empty page.
    const rows = await this.dataSource.query<CountedRun[]>(
      `WITH owned AS (
         SELECT id, "workspaceId" FROM targets WHERE id = $1 AND "workspaceId" = $2
       ), ${TARGET_RUN_CTES}, matching AS MATERIALIZED (
         SELECT ${TARGET_RUN_FIELDS_SQL}
         FROM owned_runs h
         WHERE CASE
           WHEN NOT $5::boolean THEN true
           ELSE ${TARGET_ACTIVE_RUN_CONDITION_SQL}
         END
       ), page AS MATERIALIZED (
         SELECT * FROM matching ORDER BY ${TARGET_RUN_ORDER_SQL} LIMIT $3 OFFSET $4
       )
       SELECT totals.total, p.*, stats.*, ${TARGET_RUN_STATUS_SQL} AS status
       FROM owned CROSS JOIN (SELECT COUNT(*)::int AS total FROM matching) totals
       LEFT JOIN page p ON true
       CROSS JOIN LATERAL (${TARGET_RUN_PROGRESS_SQL}) stats
       ORDER BY p."createdAt" DESC, p.id DESC`,
      [id, workspaceId, limit, offset, active],
    );
    if (!rows.length) throw new NotFoundException('Target not found');

    const [{ total }] = rows;
    const data = rows.flatMap(({ id, total: _total, ...run }) =>
      id === null ? [] : [{ id, ...run }],
    );
    return getManyResponse({
      query: { ...query, sortBy: 'createdAt' },
      data,
      total,
    });
  }
}
