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
  assetGroupControllerRunGroupWorkflowScheduler,
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  getProjectsControllerGetOverviewQueryKey,
  getProjectsControllerGetRunsQueryKey,
  useAssetGroupControllerRunGroupWorkflowScheduler,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';

export function ProjectWorkflowRunDialog({
  projectId,
  bindingId,
  workflowName,
  workspaceId,
  hasAssets,
  hasSteps,
}: {
  projectId: string;
  bindingId: string;
  workflowName: string;
  workspaceId: string;
  hasAssets: boolean;
  hasSteps: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const lock = useRef(false);
  const reasonId = useId();
  const queryClient = useQueryClient();
  const run = useAssetGroupControllerRunGroupWorkflowScheduler({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: async ({ id }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        return assetGroupControllerRunGroupWorkflowScheduler(id);
      },
    },
  });
  const invalid = isAxiosError(run.error) && run.error.response?.status === 400;
  const uncertain = run.isError && !invalid;
  const unavailable = !hasAssets
    ? 'Add project assets before starting a run'
    : !hasSteps
      ? 'The workflow has no steps'
      : undefined;

  async function start() {
    if (
      unavailable ||
      uncertain ||
      lock.current ||
      workspaceId !== getGlobalWorkspaceId()
    )
      return;
    lock.current = true;
    setStarting(true);
    try {
      const result = await run
        .mutateAsync({ id: bindingId })
        .catch(() => undefined);
      const runsKey = getProjectsControllerGetRunsQueryKey(projectId);
      const keys = result
        ? [
            runsKey,
            getProjectsControllerGetByIdQueryKey(projectId),
            getProjectsControllerGetOverviewQueryKey(projectId),
            getProjectsControllerGetManyQueryKey(),
            getAssetGroupControllerGetByIdQueryKey(projectId),
          ]
        : [runsKey];
      await Promise.all(
        keys.map((queryKey) =>
          queryClient.invalidateQueries({
            queryKey,
            refetchType:
              workspaceId === getGlobalWorkspaceId() ? 'active' : 'none',
          }),
        ),
      );
      if (!result || workspaceId !== getGlobalWorkspaceId()) return;
      setOpen(false);
      toast.success('Workflow run requested.');
    } finally {
      lock.current = false;
      setStarting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (lock.current) return;
        if (next) run.reset();
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
        {run.isError && (
          <p role="alert">
            {invalid
              ? 'Unable to start the workflow. Check the tools and current project assets.'
              : 'Could not confirm the workflow started. Check project Runs before trying again.'}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            aria-disabled={starting}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!lock.current) setOpen(false);
            }}
          >
            {uncertain ? 'Close' : 'Cancel'}
          </Button>
          {uncertain ? (
            <Button asChild variant="outline">
              <Link to="/projects/$id/runs" params={{ id: projectId }}>
                View project runs
              </Link>
            </Button>
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
