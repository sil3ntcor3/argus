import { JobStatus } from '@/common/enums/enum';

/**
 * A run's status rolled up from its jobs. Kept as one string because the same
 * expression backs both the SELECT and the status filter (HAVING).
 */
export const JOB_HISTORY_STATUS_SQL = `CASE
          WHEN COUNT(*) FILTER (WHERE job.status = '${JobStatus.CANCELLED}') > 0
               AND COUNT(*) FILTER (WHERE job.status IN ('${JobStatus.PENDING}', '${JobStatus.IN_PROGRESS}')) = 0
            THEN '${JobStatus.CANCELLED}'
          WHEN COUNT(*) FILTER (WHERE job.status = '${JobStatus.FAILED}') > 0 THEN '${JobStatus.FAILED}'
          WHEN COUNT(*) FILTER (WHERE job.status = '${JobStatus.IN_PROGRESS}') > 0 THEN '${JobStatus.IN_PROGRESS}'
          WHEN COUNT(*) FILTER (WHERE job.status = '${JobStatus.COMPLETED}') = COUNT(*) AND COUNT(*) > 0 THEN '${JobStatus.COMPLETED}'
          WHEN COUNT(*) FILTER (WHERE job.status = '${JobStatus.SKIPPED}') = COUNT(*) AND COUNT(*) > 0 THEN '${JobStatus.SKIPPED}'
          ELSE '${JobStatus.PENDING}'
        END`;
