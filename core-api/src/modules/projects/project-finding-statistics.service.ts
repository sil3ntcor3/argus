import { Severity } from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { findingLifecycleStatistics } from '../vulnerabilities/vulnerability-lifecycle-read';
import { openVulnerabilityCondition } from '../vulnerabilities/open-vulnerability';
import type { ProjectFindingStatisticsDto } from './dto/project-findings.dto';

@Injectable()
export class ProjectFindingStatisticsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Read one project snapshot; historical attribution does not depend on current membership. */
  read(
    projectId: string,
    workspaceId: string,
    canReadReview: boolean,
  ): Promise<ProjectFindingStatisticsDto> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const owned = await manager.query<{ id: string }[]>(
        'SELECT id FROM projects WHERE id=$1 AND "workspaceId"=$2',
        [projectId, workspaceId],
      );
      if (!owned.length) throw new NotFoundException('Project not found');
      const rows = await manager.query<
        { severity: Severity; count: number; pending: number }[]
      >(
        `SELECT finding.severity,
          COUNT(*) FILTER(WHERE finding."reviewStatus"='approved' AND ${openVulnerabilityCondition('finding')})::int AS count,
          COUNT(*) FILTER(WHERE finding."reviewStatus"='pending_review')::int AS pending
         FROM project_vulnerabilities link JOIN vulnerabilities finding ON finding.id=link."vulnerabilityId"
         JOIN assets asset ON asset.id=finding."assetId" JOIN targets target ON target.id=asset."targetId"
         WHERE link."projectId"=$1 AND target."workspaceId"=$2 GROUP BY finding.severity`,
        [projectId, workspaceId],
      );
      return {
        data: Object.values(Severity).map((severity) => ({
          severity,
          count: rows.find((row) => row.severity === severity)?.count ?? 0,
        })),
        pendingReview: canReadReview
          ? rows.reduce((sum, row) => sum + row.pending, 0)
          : null,
        ...(await findingLifecycleStatistics(
          manager,
          workspaceId,
          undefined,
          projectId,
        )),
      };
    });
  }
}
