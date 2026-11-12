import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import {
  WorkflowFileSheet,
  workflowYaml,
} from '@/components/common/workflow-file-sheet';
import { Button } from '@/components/ui/button';
import JobStatusBadge from '@/components/ui/job-status';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { formatCronLabel } from '@/lib/cron-schedule';
import {
  type AssetGroupWorkflow,
  type Workflow,
  useProjectsControllerGetById,
  useProjectsControllerGetTriggers,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { projectRouteId } from './project-route-id';
import { ProjectWorkflowCreateDialog } from './project-workflow-create-dialog';
import { ProjectWorkflowDetachDialog } from './project-workflow-detach-dialog';
import { projectWorkflowLabel } from './project-workflow-label';
import { ProjectWorkflowRenameDialog } from './project-workflow-rename-dialog';
import { ProjectWorkflowPipelineDialog } from './project-workflow-pipeline-dialog';
import { ProjectWorkflowRunDialog } from './project-workflow-run-dialog';
import { ProjectWorkflowScheduleDialog } from './project-workflow-schedule-dialog';
import { ProjectTriggerCronDialog } from './project-trigger-cron-dialog';
import {
  ProjectWorkflowTriggers,
  type TriggerQuery,
} from './project-workflow-triggers';

const runDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Use the detail payload's existing path and edit flags for ownership. */
function canRenameWorkflow(workflow: Workflow | undefined, projectId: string) {
  if (
    !workflow?.isCanEdit ||
    !workflow.isCanDelete ||
    !('filePath' in workflow) ||
    typeof workflow.filePath !== 'string'
  )
    return false;
  return (
    workflow.filePath.startsWith(`project-${projectId}-`) ||
    workflow.filePath === `group-${projectId}.yaml` ||
    workflow.filePath === `group-workflow---${projectId}.yaml`
  );
}

function WorkflowCard({
  binding,
  canOpenRuns,
  projectId,
  editWorkspaceId,
  runWorkspaceId,
  hasAssets,
  focusAssignments,
  triggers,
}: {
  binding: AssetGroupWorkflow;
  canOpenRuns: boolean;
  projectId: string;
  editWorkspaceId?: string;
  runWorkspaceId?: string;
  hasAssets: boolean;
  focusAssignments: () => void;
  triggers: TriggerQuery;
}) {
  const [sourceRequested, setSourceRequested] = useState(false);
  const name = projectWorkflowLabel(binding.workflow);
  const definition = binding.workflow?.content;
  const yaml = useMemo(
    () => (sourceRequested ? workflowYaml(definition) : ''),
    [definition, sourceRequested],
  );
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
      <ProjectWorkflowTriggers
        bindingId={binding.id}
        workflowName={name}
        query={triggers}
      />
      {(editWorkspaceId || definition || runWorkspaceId) && (
        <div className="flex flex-wrap gap-2">
          {editWorkspaceId &&
            canRenameWorkflow(binding.workflow, projectId) && (
              <ProjectTriggerCronDialog
                projectId={projectId}
                bindingId={binding.id}
                workflowName={name}
                workspaceId={editWorkspaceId}
              />
            )}
          {runWorkspaceId && (
            <ProjectWorkflowRunDialog
              projectId={projectId}
              bindingId={binding.id}
              workflowName={name}
              workspaceId={runWorkspaceId}
              hasAssets={hasAssets}
              hasSteps={Boolean(
                definition?.jobs && Object.keys(definition.jobs).length,
              )}
            />
          )}
          {editWorkspaceId &&
            canRenameWorkflow(binding.workflow, projectId) && (
              <ProjectWorkflowRenameDialog
                projectId={projectId}
                bindingId={binding.id}
                workflowName={name}
                workspaceId={editWorkspaceId}
              />
            )}
          {editWorkspaceId &&
            canRenameWorkflow(binding.workflow, projectId) && (
              <ProjectWorkflowPipelineDialog
                projectId={projectId}
                binding={binding}
                workflowName={name}
                workspaceId={editWorkspaceId}
              />
            )}
          {editWorkspaceId && (
            <ProjectWorkflowScheduleDialog
              projectId={projectId}
              bindingId={binding.id}
              workflowName={name}
              schedule={cron}
              workspaceId={editWorkspaceId}
            />
          )}
          {editWorkspaceId && binding.workflow?.id && (
            <ProjectWorkflowDetachDialog
              projectId={projectId}
              bindingId={binding.id}
              workflowId={binding.workflow.id}
              workflowName={name}
              workspaceId={editWorkspaceId}
              focusAssignments={focusAssignments}
            />
          )}
          {definition && (
            <WorkflowFileSheet
              triggerLabel={`View workflow for ${name}`}
              description={`Saved definition for ${name}`}
              onOpenChange={(open) => {
                if (open) setSourceRequested(true);
              }}
              yaml={yaml}
            />
          )}
        </div>
      )}
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
  editWorkspaceId,
  runWorkspaceId,
}: {
  projectId: string;
  canOpenRuns: boolean;
  editWorkspaceId?: string;
  runWorkspaceId?: string;
}) {
  const assignments = useRef<HTMLElement>(null);
  const project = useProjectsControllerGetById(projectId, {
    query: { retry: false },
  });
  const triggers = useProjectsControllerGetTriggers(projectId, {
    query: {
      retry: false,
      enabled:
        !project.isError && Boolean(project.data?.assetGroupWorkflows?.length),
    },
  });
  const status = isAxiosError(project.error)
    ? project.error.response?.status
    : undefined;

  if (status === 401 || status === 403) return <AccessDenied />;
  if (status === 404) return <p role="status">Project not found</p>;
  if (project.isError && !project.data)
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
  const hasAssets = project.data.totalAssets > 0;

  return (
    <section ref={assignments} tabIndex={-1} aria-label="Workflow assignments">
      {editWorkspaceId && (
        <div className="mb-3 flex justify-end">
          <ProjectWorkflowCreateDialog
            projectId={projectId}
            workspaceId={editWorkspaceId}
          />
        </div>
      )}
      {bindings.length ? (
        <ul aria-label="Project workflows" className="space-y-2">
          {bindings.map((binding) => (
            <WorkflowCard
              key={binding.id}
              binding={binding}
              canOpenRuns={canOpenRuns}
              projectId={projectId}
              editWorkspaceId={editWorkspaceId}
              runWorkspaceId={runWorkspaceId}
              hasAssets={hasAssets}
              triggers={triggers}
              focusAssignments={() => assignments.current?.focus()}
            />
          ))}
        </ul>
      ) : (
        <p role="status">No workflows assigned to this project</p>
      )}
    </section>
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
          key={`${state.selectedWorkspaceId}:${parsedId.data}`}
          projectId={parsedId.data}
          canOpenRuns={permission.hasPermission('job.read')}
          runWorkspaceId={
            permission.hasPermission('workflow.write')
              ? state.selectedWorkspaceId
              : undefined
          }
          editWorkspaceId={
            permission.hasPermission('project.write') ||
            permission.hasPermission('group.write')
              ? state.selectedWorkspaceId
              : undefined
          }
        />
      </div>
    );
  return (
    <Page title="Project workflows" className="[overflow-wrap:anywhere]">
      {content}
    </Page>
  );
}
