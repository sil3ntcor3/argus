import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  PROJECT_ACTIVITY_LIMIT,
  ProjectOverviewActivityService,
  type ProjectNonRunActivity,
} from './project-overview-activity.service';
import { ProjectOverviewCountsService } from './project-overview-counts.service';
import { ProjectOverviewRunsService } from './project-overview-runs.service';
import { ProjectRunReadService } from './project-run-read.service';

type OverviewRunActivity = Awaited<
  ReturnType<ProjectRunReadService['listActivity']>
>[number];

type ProjectOverviewView = Awaited<
  ReturnType<ProjectOverviewCountsService['read']>
> &
  Awaited<ReturnType<ProjectOverviewRunsService['read']>> & {
    activity: (OverviewRunActivity | ProjectNonRunActivity)[];
  };

@Injectable()
export class ProjectOverviewReadService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly counts: ProjectOverviewCountsService,
    private readonly runs: ProjectOverviewRunsService,
    private readonly runReader: ProjectRunReadService,
    private readonly activity: ProjectOverviewActivityService,
  ) {}

  read(projectId: string, workspaceId: string): Promise<ProjectOverviewView> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const counts = await this.counts.read(
        projectId,
        workspaceId,
        undefined,
        manager,
      );
      const runs = await this.runs.read(
        projectId,
        workspaceId,
        undefined,
        manager,
      );
      const runActivity = await this.runReader.listActivity(
        projectId,
        workspaceId,
        manager,
      );
      const activity = await this.activity.read(
        projectId,
        workspaceId,
        manager,
      );
      return {
        ...counts,
        ...runs,
        // The feed serializes milliseconds. At equal display times, preserve
        // each source's ordering and place runs before audit and dismissals.
        activity: [...runActivity, ...activity]
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .slice(0, PROJECT_ACTIVITY_LIMIT),
      };
    });
  }
}
