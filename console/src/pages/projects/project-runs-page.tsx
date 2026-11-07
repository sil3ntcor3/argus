import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import JobStatusBadge from '@/components/ui/job-status';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type ProjectRunDto,
  type ProjectsControllerGetRunsJobRunType,
  useProjectsControllerGetRuns,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import type { ReactNode } from 'react';
import { z } from 'zod';

type RunsSearch = {
  page: number;
  trigger?: ProjectsControllerGetRunsJobRunType;
};
type RunsProps = RunsSearch & {
  projectId: string;
  onChange: (search: RunsSearch) => void;
};

const projectIdSchema = z.string().uuid();
const startedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Renders a saved run summary with a job link for readers who can open it. */
function ProjectRunCard({
  run,
  canOpen,
}: {
  run: ProjectRunDto;
  canOpen: boolean;
}) {
  const name = run.workflowName.trim() || 'Workflow run';
  const trigger = run.jobRunType === 'scheduled' ? 'Scheduled' : 'Manual';
  const started = startedAt.format(new Date(run.createdAt));

  return (
    <li className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h2 className="font-medium">
          {canOpen ? (
            <Link
              to="/jobs/runs/$id"
              params={{ id: run.id }}
              aria-label={`${name}, ${trigger}, ${started}, run ${run.id.slice(0, 6)}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:underline"
            >
              {name}
            </Link>
          ) : (
            name
          )}
        </h2>
        <JobStatusBadge status={run.status} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>{trigger}</span>
        <time dateTime={run.createdAt}>{started}</time>
        <span>{run.scopeSize} in scope</span>
        <span>
          {run.stepsDone}/{run.stepsTotal} steps done · {run.stepsFailed} failed
        </span>
        <span>
          {run.newVulnerabilities} new · {run.recurringVulnerabilities}{' '}
          recurring
        </span>
      </div>
    </li>
  );
}

/** Loads the selected page and trigger for an authorized project. */
function ProjectRunList({
  projectId,
  page,
  trigger,
  onChange,
  canOpen,
}: RunsProps & {
  canOpen: boolean;
}) {
  const { data, error, isError, isPending, isFetching, refetch } =
    useProjectsControllerGetRuns(
      projectId,
      { page, limit: 20, jobRunType: trigger },
      {
        query: {
          retry: false,
          refetchInterval: (query) =>
            query.state.status === 'error' ? false : 15_000,
        },
      },
    );
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 403) return <AccessDenied />;
  if (status === 404) return <p role="status">Project not found</p>;

  let results: ReactNode;
  if (isError) {
    results = (
      <div className="flex items-center gap-3">
        <p role="status">Unable to load project runs</p>
        <Button
          variant="outline"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );
  } else if (isPending || !data) {
    results = (
      <Skeleton
        role="status"
        aria-label="Loading project runs"
        className="h-32 rounded-xl"
      />
    );
  } else if (!data.data.length) {
    results = (
      <p role="status">{page > 1 ? 'No runs on this page' : 'No runs found'}</p>
    );
  } else {
    results = (
      <ol aria-label="Project runs" className="space-y-2">
        {data.data.map((run) => (
          <ProjectRunCard key={run.id} run={run} canOpen={canOpen} />
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-4">
      <label className="flex w-fit items-center gap-2 text-sm">
        Trigger
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={trigger ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              page: 1,
              trigger:
                value === 'manual' || value === 'scheduled' ? value : undefined,
            });
          }}
        >
          <option value="">All triggers</option>
          <option value="manual">Manual</option>
          <option value="scheduled">Scheduled</option>
        </select>
      </label>
      {results}
      <nav
        aria-label="Project run pages"
        className="flex flex-wrap items-center gap-3"
      >
        <Button
          variant="outline"
          aria-disabled={page <= 1}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (page > 1)
              onChange({
                page: page > (data?.pageCount ?? page) ? 1 : page - 1,
                trigger,
              });
          }}
        >
          Previous
        </Button>
        <span aria-live="polite">{data ? `Page ${page}` : ''}</span>
        <Button
          variant="outline"
          aria-disabled={!data?.hasNextPage}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (data?.hasNextPage) onChange({ page: page + 1, trigger });
          }}
        >
          Next
        </Button>
      </nav>
    </div>
  );
}

/** Gates the project runs request on workspace, project ID, and permission. */
export function ProjectRunsPage(props: RunsProps) {
  const { state } = useWorkspaceState();
  const permission = usePermission();
  const canRead =
    permission.hasPermission('project.read') ||
    permission.hasPermission('group.read');
  const validProject = projectIdSchema.safeParse(props.projectId).success;

  let content: ReactNode;
  if (!state.selectedWorkspaceId)
    content = <p role="status">Select a workspace</p>;
  else if (permission.isLoading)
    content = <p role="status">Loading project access</p>;
  else if (permission.error)
    content = <p role="status">Unable to load project access</p>;
  else if (!canRead) content = <AccessDenied />;
  else if (!validProject) content = <p role="status">Project not found</p>;
  else
    content = (
      <div className="space-y-4">
        <Link
          to="/projects/$id"
          params={{ id: props.projectId }}
          className="text-sm text-primary hover:underline"
        >
          Back to project overview
        </Link>
        <ProjectRunList
          {...props}
          canOpen={permission.hasPermission('job.read')}
        />
      </div>
    );

  return (
    <Page title="Project runs" className="[overflow-wrap:anywhere]">
      {content}
    </Page>
  );
}
