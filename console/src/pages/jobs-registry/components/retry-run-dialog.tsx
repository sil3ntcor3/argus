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
  getJobsRegistryControllerGetManyJobHistoriesQueryKey,
  jobsRegistryControllerRetryJobHistory,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { isAxiosError, type AxiosRequestTransformer } from 'axios';
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const WORKSPACE_CHANGED =
  'The selected workspace changed. Reopen the run to retry.';
const REJECTED =
  'This run could not be retried. Check its current scope and permissions.';
const UNCERTAIN =
  'Could not confirm the retry started. Check Runs before trying again.';

export function RetryRunDialog({
  runId,
  workspaceId,
}: {
  runId: string;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string>();
  const mounted = useRef(false);
  const submitting = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutationKey = ['retry-run', workspaceId, runId];
  const retry = useMutation({
    mutationKey,
    networkMode: 'always',
    retry: false,
    mutationFn: () => {
      // This runs after Axios injects the workspace header and before it sends the POST.
      const verifyWorkspace: AxiosRequestTransformer = (data, headers) => {
        if (
          workspaceId !== getGlobalWorkspaceId() ||
          headers.get('X-Workspace-Id') !== workspaceId
        ) {
          throw new Error(WORKSPACE_CHANGED);
        }
        return data;
      };
      return jobsRegistryControllerRetryJobHistory(runId, {
        transformRequest: [verifyWorkspace],
      });
    },
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (problem) closeButton.current?.focus();
  }, [problem]);

  async function start() {
    if (
      submitting.current ||
      problem ||
      queryClient.isMutating({ mutationKey })
    )
      return;
    if (workspaceId !== getGlobalWorkspaceId()) {
      setProblem(WORKSPACE_CHANGED);
      return;
    }

    submitting.current = true;
    const result = await retry.mutateAsync().catch((error: unknown) => {
      if (!mounted.current) return;
      const status = isAxiosError(error)
        ? (error.response?.status ?? error.status)
        : undefined;
      setProblem(
        error instanceof Error && error.message === WORKSPACE_CHANGED
          ? WORKSPACE_CHANGED
          : status && [400, 401, 403, 404, 409].includes(status)
            ? REJECTED
            : UNCERTAIN,
      );
    });
    if (!result) {
      submitting.current = false;
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: getJobsRegistryControllerGetManyJobHistoriesQueryKey(),
      refetchType: 'none',
    });
    if (mounted.current && workspaceId === getGlobalWorkspaceId()) {
      setOpen(false);
      await navigate({
        to: '/jobs/runs/$id',
        params: { id: result.jobHistoryId },
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting.current) return;
        if (next) setProblem(undefined);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <RotateCcw className="h-4 w-4" aria-hidden />
          Retry run
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Retry this run?</DialogTitle>
          <DialogDescription>
            Start a new run using the current workflow and the original scope.
            The original run will keep its results.
          </DialogDescription>
        </DialogHeader>
        {problem && <p role="alert">{problem}</p>}
        <DialogFooter>
          <Button
            ref={closeButton}
            variant="outline"
            aria-disabled={retry.isPending}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!submitting.current) setOpen(false);
            }}
          >
            {problem ? 'Close' : 'Keep run'}
          </Button>
          {problem === UNCERTAIN && (
            <Button asChild variant="outline">
              <Link to="/jobs">View runs</Link>
            </Button>
          )}
          {!problem && (
            <Button
              aria-disabled={retry.isPending}
              className="aria-disabled:opacity-50"
              onClick={() => void start()}
            >
              {retry.isPending ? 'Starting…' : 'Start retry'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
