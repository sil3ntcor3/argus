import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  projectsControllerRunWorkflow,
  getProjectsControllerGetByIdQueryKey,
} from '@/services/apis/gen/queries';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useProjectWorkflowAction } from './use-project-workflow-action';

export function ProjectWorkflowRunDialog({
  projectId,
  bindingId,
  workflowName,
  workspaceId,
  hasAssets,
  hasSteps,
  canOpenRuns = false,
}: {
  projectId: string;
  bindingId: string;
  workflowName: string;
  workspaceId: string;
  hasAssets: boolean;
  hasSteps: boolean;
  canOpenRuns?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const run = useProjectWorkflowAction(
    workspaceId,
    projectId,
    bindingId,
    'run',
  );
  const finishing = useRef(false);
  const [settling, setSettling] = useState(false);
  const starting = run.busy || settling;
  const uncertain = run.uncertain;
  const unavailable = !hasAssets
    ? 'Add project assets before starting a run'
    : !hasSteps
      ? 'The workflow has no steps'
      : undefined;

  async function start() {
    if (unavailable || finishing.current) return;
    finishing.current = true;
    setSettling(true);
    try {
      const result = await run.execute((signal) =>
        projectsControllerRunWorkflow(
          projectId,
          bindingId,
          {},
          {
            signal,
            timeout: 30_000,
            headers: { 'X-Workspace-Id': workspaceId },
          },
        ),
      );
      if (!result || !run.current()) return;
      const root = getProjectsControllerGetByIdQueryKey(projectId)[0];
      await queryClient.invalidateQueries({
        predicate: ({ queryKey: [path] }) =>
          typeof path === 'string' &&
          (path === root || path.startsWith(root + '/')),
      });
      if (!run.current()) return;
      setOpen(false);
      toast.success(`Workflow started for ${result.assets} assets.`);
      if (canOpenRuns)
        await navigate({
          to: '/jobs/runs/$id',
          params: { id: result.jobHistoryId },
        });
    } finally {
      finishing.current = false;
      if (run.current()) setSettling(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (finishing.current || run.isLocked()) return;
        if (next) run.resetSuccess();
        setOpen(next);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(unavailable)}
            aria-label={`Run workflow for ${workflowName}`}
            aria-describedby={unavailable ? reasonId : undefined}
          >
            Run workflow
          </Button>
        </DialogTrigger>
        {unavailable && (
          <span id={reasonId} className="text-xs text-muted-foreground">
            {unavailable}
          </span>
        )}
      </div>
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={!starting && !uncertain}
      >
        <DialogHeader>
          <DialogTitle>Run project workflow</DialogTitle>
          <DialogDescription>
            Start {workflowName} using the current project assets?
          </DialogDescription>
        </DialogHeader>
        {unavailable && <p role="status">{unavailable}</p>}
        {(run.error || uncertain) && (
          <p role="alert">
            {uncertain
              ? 'Could not confirm the workflow started. Check project Runs before trying again.'
              : run.error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            aria-disabled={starting}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!finishing.current && !run.isLocked()) setOpen(false);
            }}
          >
            {uncertain ? 'Close' : 'Cancel'}
          </Button>
          {uncertain ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link to="/projects/$id/runs" params={{ id: projectId }}>
                  View project runs
                </Link>
              </Button>
              <Button variant="outline" onClick={run.acknowledge}>
                I checked; allow a new request
              </Button>
            </div>
          ) : (
            <Button
              disabled={Boolean(unavailable)}
              aria-disabled={starting}
              className="aria-disabled:opacity-50"
              onClick={() => void start()}
            >
              {starting ? 'Starting…' : 'Start run'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
