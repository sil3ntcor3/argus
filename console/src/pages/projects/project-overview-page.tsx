import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type ProjectOverviewDto,
  useProjectsControllerGetById,
  useProjectsControllerGetOverview,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import type { ReactNode } from 'react';
import { ProjectFindingTrends } from './project-finding-trends';
import { ProjectOverviewActivity } from './project-overview-activity';
import { ProjectOverviewRuns } from './project-overview-runs';
import { projectRouteId } from './project-route-id';

const countFormat = new Intl.NumberFormat();

/** Shows a responsive placeholder while the project or permissions load. */
function OverviewLoading() {
  return (
    <div
      role="status"
      aria-label="Loading project overview"
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}

/** Shows an unavailable project state without rendering cached project data. */
function OverviewNotice({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      role="status"
      className="rounded-xl border bg-card px-5 py-8 text-center"
    >
      <h2 className="font-semibold text-card-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

/** Displays the four counts in a project overview. */
function OverviewSummary({ overview }: { overview: ProjectOverviewDto }) {
  const openFindings = Object.values(overview.openVulnerabilities).reduce(
    (total, count) => total + count,
    0,
  );
  const metrics = [
    {
      label: 'Assets',
      count: overview.totalAssets,
      detail: `${countFormat.format(overview.newAssets)} added in the last 7 days`,
    },
    {
      label: 'Workflows',
      count: overview.workflows,
      detail: 'Assigned to this project',
    },
    {
      label: 'Open findings',
      count: openFindings,
      detail: 'Across all severities',
    },
    {
      label: 'New findings',
      count: overview.newVulnerabilities,
      detail: 'Open findings first seen in the last 7 days',
    },
  ];

  return (
    <section aria-labelledby="project-summary-heading" className="space-y-3">
      <h2 id="project-summary-heading" className="text-base font-semibold">
        Project summary
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, count, detail }) => (
          <div
            key={label}
            className="min-w-0 rounded-xl border bg-card p-4 text-card-foreground"
          >
            <dt className="text-sm font-medium text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {countFormat.format(count)}
            </dd>
            <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Shows the read-only overview for the selected workspace and project. */
export function ProjectOverviewPage({ projectId }: { projectId: string }) {
  const { state } = useWorkspaceState();
  const permission = usePermission();
  const canRead =
    permission.hasPermission('project.read') ||
    permission.hasPermission('group.read');
  // The router decodes path parameters. Only pass project UUIDs to the API.
  const validId = projectRouteId.safeParse(projectId).success;
  const enabled = Boolean(
    state.selectedWorkspaceId &&
    !permission.isLoading &&
    !permission.error &&
    canRead &&
    validId,
  );
  // A missing project is terminal for this workspace. Show that state without
  // waiting through the console's default retry schedule.
  const options = { query: { enabled, retry: false as const } };
  const project = useProjectsControllerGetById(projectId, options);
  const overview = useProjectsControllerGetOverview(projectId, options);
  const error = project.error ?? overview.error;
  const status = isAxiosError(error) ? error.response?.status : undefined;

  let title = 'Project overview';
  let description: string | undefined;
  let content: ReactNode;
  if (!state.selectedWorkspaceId) {
    content = (
      <OverviewNotice
        title="Select a workspace"
        description="Choose the workspace that contains this project."
      />
    );
  } else if (permission.isLoading) {
    content = <OverviewLoading />;
  } else if (permission.error) {
    content = (
      <OverviewNotice
        title="Unable to load project access"
        description="Reload the page to try again."
      />
    );
  } else if (!canRead || status === 403) {
    content = <AccessDenied />;
  } else if (!validId || status === 404) {
    content = (
      <OverviewNotice
        title="Project not found"
        description="Check the project link and selected workspace."
      />
    );
  } else if (project.isError || overview.isError) {
    content = (
      <OverviewNotice
        title="Unable to load the project overview"
        description="Reload the page to try again."
      />
    );
  } else if (
    project.isPending ||
    overview.isPending ||
    !project.data ||
    !overview.data
  ) {
    content = <OverviewLoading />;
  } else {
    title = project.data.name;
    description = project.data.description ?? undefined;
    const canOpenRuns = permission.hasPermission('job.read');
    content = (
      <div className="space-y-4">
        <OverviewSummary overview={overview.data} />
        <Link
          to="/projects/$id/findings"
          params={{ id: projectId }}
          className="inline-block text-sm font-medium text-primary hover:underline"
        >
          View open findings
        </Link>
        <Link
          to="/projects/$id/assets"
          params={{ id: projectId }}
          className="ms-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          View project assets
        </Link>
        <ProjectFindingTrends weeks={overview.data.weekly} />
        <ProjectOverviewRuns
          lastRun={overview.data.lastRun}
          discoveryRuns={overview.data.newVulnerabilityRuns}
          canOpenRuns={canOpenRuns}
        />
        <Link
          to="/projects/$id/runs"
          params={{ id: projectId }}
          className="inline-block text-sm font-medium text-primary hover:underline"
        >
          View all runs
        </Link>
        <ProjectOverviewActivity
          events={overview.data.activity}
          canOpenRuns={canOpenRuns}
        />
      </div>
    );
  }

  return (
    <Page
      title={title}
      description={description}
      className="[overflow-wrap:anywhere]"
    >
      {content}
    </Page>
  );
}
