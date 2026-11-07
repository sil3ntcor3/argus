import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import JobStatusBadge from '@/components/ui/job-status';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { formatCronLabel } from '@/lib/cron-schedule';
import {
  type AssetGroupWorkflow,
  useProjectsControllerGetById,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import type { ReactNode } from 'react';
import { projectRouteId } from './project-route-id';
import { projectWorkflowLabel } from './project-workflow-label';

const runDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function WorkflowCard({
  binding,
  canOpenRuns,
}: {
  binding: AssetGroupWorkflow;
  canOpenRuns: boolean;
}) {
  const name = projectWorkflowLabel(binding.workflow);
  const cron = binding.schedule;
  const scheduled = cron && cron !== 'disabled';
  const scheduleLabel =
    scheduled && cron.trim().split(/\s+/)[3] === '*'
      ? formatCronLabel(cron, 'UTC')
      : null;
  const lastRun = binding.lastRun;
  const timestamp = lastRun && runDate.format(new Date(lastRun.createdAt));

  return (
    <li className="min-w-0 space-y-2 rounded-xl border bg-card p-4">
      <h2 className="font-medium">{name}</h2>
      <p className="text-sm text-muted-foreground">
        {scheduled
          ? scheduleLabel
            ? `${scheduleLabel} (UTC)`
            : `${cron} UTC`
          : 'Schedule disabled'}
      </p>
      {lastRun ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <JobStatusBadge status={lastRun.status} />
          <span>Latest run</span>
          {canOpenRuns ? (
            <Link
              to="/jobs/runs/$id"
              params={{ id: lastRun.id }}
              aria-label={`${timestamp}, latest run for ${name}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:underline"
            >
              <time dateTime={lastRun.createdAt}>{timestamp}</time>
            </Link>
          ) : (
            <time dateTime={lastRun.createdAt}>{timestamp}</time>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No run summary available
        </p>
      )}
    </li>
  );
}

function WorkflowList({
  projectId,
  canOpenRuns,
}: {
  projectId: string;
  canOpenRuns: boolean;
}) {
  const project = useProjectsControllerGetById(projectId, {
    query: { retry: false },
  });
  const status = isAxiosError(project.error)
    ? project.error.response?.status
    : undefined;

  if (status === 401 || status === 403) return <AccessDenied />;
  if (status === 404) return <p role="status">Project not found</p>;
  if (project.isError)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load project workflows</p>
        <Button
          variant="outline"
          disabled={project.isFetching}
          onClick={() => void project.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  if (!project.data)
    return (
      <Skeleton
        role="status"
        aria-label="Loading project workflows"
        className="h-32 rounded-xl"
      />
    );
  const bindings = project.data.assetGroupWorkflows ?? [];
  if (!bindings.length)
    return <p role="status">No workflows assigned to this project</p>;

  return (
    <ul aria-label="Project workflows" className="space-y-2">
      {bindings.map((binding) => (
        <WorkflowCard
          key={binding.id}
          binding={binding}
          canOpenRuns={canOpenRuns}
        />
      ))}
    </ul>
  );
}

export function ProjectWorkflowsPage({ projectId }: { projectId: string }) {
  const { state } = useWorkspaceState();
  const permission = usePermission();
  const parsedId = projectRouteId.safeParse(projectId);
  let content: ReactNode;
  if (!state.selectedWorkspaceId)
    content = <p role="status">Select a workspace</p>;
  else if (permission.isLoading)
    content = <p role="status">Loading project access</p>;
  else if (permission.error)
    content = <p role="status">Unable to load project access</p>;
  else if (
    !permission.hasPermission('project.read') &&
    !permission.hasPermission('group.read')
  )
    content = <AccessDenied />;
  else if (!parsedId.success) content = <p role="status">Project not found</p>;
  else
    content = (
      <div className="space-y-4">
        <Link
          to="/projects/$id"
          params={{ id: parsedId.data }}
          className="text-sm text-primary hover:underline"
        >
          Back to project overview
        </Link>
        <WorkflowList
          projectId={parsedId.data}
          canOpenRuns={permission.hasPermission('job.read')}
        />
      </div>
    );
  return (
    <Page title="Project workflows" className="[overflow-wrap:anywhere]">
      {content}
    </Page>
  );
}
