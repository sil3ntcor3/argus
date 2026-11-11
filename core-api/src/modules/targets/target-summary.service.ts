import { CronSchedule, JobStatus } from '@/common/enums/enum';
import { openVulnerabilityCondition } from '@/modules/vulnerabilities/open-vulnerability';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TargetSummaryDto } from './dto/target-summary.dto';
import { staleTargetCondition } from './stale-target-condition';

type FindingFields = Pick<
  TargetSummaryDto,
  'withCritical' | 'openVulnerabilities'
>;
type TargetCounts = Omit<TargetSummaryDto, keyof FindingFields>;
type FindingCounts = NonNullable<FindingFields['openVulnerabilities']> & {
  withCritical: number;
};

@Injectable()
export class TargetSummaryService {
  constructor(private readonly dataSource: DataSource) {}

  async getSummary(
    workspaceId: string,
    canReadFindings: boolean,
  ): Promise<TargetSummaryDto> {
    const [counts] = await this.dataSource.query<TargetCounts[]>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM assets a JOIN jobs j ON j."assetId" = a.id
                WHERE a."targetId" = t.id AND j.status IN ($2, $3)
              ))::int AS scanning,
              COUNT(*) FILTER (WHERE t."scanSchedule" <> $4)::int AS scheduled,
              COUNT(*) FILTER (WHERE ${staleTargetCondition('t')})::int AS stale
         FROM targets t WHERE t."workspaceId" = $1`,
      [
        workspaceId,
        JobStatus.PENDING,
        JobStatus.IN_PROGRESS,
        CronSchedule.DISABLED,
      ],
    );

    if (!canReadFindings) {
      return { ...counts, withCritical: null, openVulnerabilities: null };
    }

    const [{ withCritical, ...openVulnerabilities }] =
      await this.dataSource.query<FindingCounts[]>(
        `SELECT COUNT(DISTINCT t.id) FILTER (WHERE v.severity = 'critical')::int AS "withCritical",
                COUNT(*) FILTER (WHERE v.severity = 'critical')::int AS critical,
                COUNT(*) FILTER (WHERE v.severity = 'high')::int AS high,
                COUNT(*) FILTER (WHERE v.severity = 'medium')::int AS medium,
                COUNT(*) FILTER (WHERE v.severity = 'low')::int AS low,
                COUNT(*) FILTER (WHERE v.severity = 'info')::int AS info
           FROM targets t
           JOIN assets a ON a."targetId" = t.id
           JOIN vulnerabilities v ON v."assetId" = a.id
          WHERE t."workspaceId" = $1 AND ${openVulnerabilityCondition('v')}`,
        [workspaceId],
      );
    return { ...counts, withCritical, openVulnerabilities };
  }
}
