import { JobStatus } from '@/common/enums/enum';
import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JOB_HISTORY_STATUS_SQL } from '../jobs-registry/job-history-status';
import type {
  GetTargetRunsQueryDto,
  TargetRunDto,
} from './dto/target-runs.dto';

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
       ), target_assets AS MATERIALIZED (
         SELECT a.id FROM assets a JOIN owned t ON a."targetId" = t.id
       ), target_runs AS (
         SELECT h.id FROM owned t JOIN workflows w ON w."workspaceId" = t."workspaceId"
         JOIN job_histories h ON h."workflowId" = w.id
         WHERE h.scope -> 'targetIds' @> jsonb_build_array(t.id::text)
         UNION
         SELECT job."jobHistoryId" FROM jobs job JOIN target_assets a ON a.id = job."assetId"
         WHERE job."jobHistoryId" IS NOT NULL
       ), matching AS MATERIALIZED (
         SELECT h.id, h."createdAt", h."updatedAt", h."jobRunType", w.name AS "workflowName"
         FROM target_runs r JOIN job_histories h ON h.id = r.id
         JOIN workflows w ON w.id = h."workflowId"
         JOIN owned t ON w."workspaceId" = t."workspaceId"
         WHERE CASE
           WHEN NOT $5::boolean THEN true
           WHEN h."isCompleted" IS DISTINCT FROM FALSE
             OR h."createdAt" <= LOCALTIMESTAMP - INTERVAL '7 days' THEN false
           ELSE (SELECT ${JOB_HISTORY_STATUS_SQL}
                   FROM jobs job WHERE job."jobHistoryId" = h.id)
                IN ('${JobStatus.PENDING}', '${JobStatus.IN_PROGRESS}')
         END
       ), page AS MATERIALIZED (
         SELECT * FROM matching ORDER BY "createdAt" DESC, id DESC LIMIT $3 OFFSET $4
       )
       SELECT totals.total, p.*, stats.*,
         (SELECT ${JOB_HISTORY_STATUS_SQL} FROM jobs job WHERE job."jobHistoryId" = p.id) AS status
       FROM owned CROSS JOIN (SELECT COUNT(*)::int AS total FROM matching) totals
       LEFT JOIN page p ON true
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS "jobsTotal",
                COUNT(*) FILTER (WHERE job.status IN ('${JobStatus.COMPLETED}', '${JobStatus.SKIPPED}'))::int AS "jobsDone",
                COUNT(*) FILTER (WHERE job.status = '${JobStatus.FAILED}')::int AS "jobsFailed",
                COUNT(*) FILTER (WHERE job.status = '${JobStatus.IN_PROGRESS}')::int AS "jobsRunning"
         FROM jobs job JOIN target_assets a ON a.id = job."assetId"
         WHERE job."jobHistoryId" = p.id
       ) stats
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
