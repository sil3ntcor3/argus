import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  getJobsRegistryControllerGetJobHistoryDetailQueryKey,
  jobsRegistryControllerCancelJobHistory,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { type RefObject, useRef } from 'react';
import { toast } from 'sonner';

/** Confirms whole-run cancellation and refreshes every target affected by it. */
export function TargetRunCancel({
  runId,
  name,
  focusAfterCancel,
}: {
  runId: string;
  name: string;
  focusAfterCancel: RefObject<HTMLElement | null>;
}) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const queryClient = useQueryClient();
  const confirmed = useRef(false);
  const mutationKey = ['cancel-target-run', selectedWorkspaceId, runId];
  const pending = useIsMutating({ mutationKey, exact: true }) > 0;
  const isCurrentWorkspace = () =>
    Boolean(selectedWorkspaceId) &&
    getGlobalWorkspaceId() === selectedWorkspaceId;
  const refresh = () => {
    const refetchType = isCurrentWorkspace() ? 'active' : 'none';
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['target-runs', selectedWorkspaceId],
        refetchType,
      }),
      queryClient.invalidateQueries({
        queryKey: ['target-overview', selectedWorkspaceId],
        refetchType,
      }),
      queryClient.invalidateQueries({
        queryKey: getJobsRegistryControllerGetJobHistoryDetailQueryKey(runId),
        refetchType,
      }),
    ]);
  };
  const { mutate } = useMutation({
    mutationKey,
    networkMode: 'always',
    retry: false,
    mutationFn: () => {
      if (!isCurrentWorkspace()) throw new Error('Workspace changed');
      return jobsRegistryControllerCancelJobHistory(runId);
    },
    onSuccess: async () => {
      if (isCurrentWorkspace()) toast.success('Run cancelled.');
      await refresh();
    },
    onError: async (error) => {
      if (isAxiosError(error) && error.response?.status === 409) {
        if (isCurrentWorkspace()) toast.info('This run has already closed.');
        await refresh();
      } else if (isCurrentWorkspace()) {
        toast.error('Could not cancel the run.');
      }
    },
  });

  return (
    <ConfirmDialog
      title="Cancel this run?"
      description="This cancels the entire run, including jobs for other targets, and stops the workflow from starting new jobs."
      confirmText="Cancel run"
      cancelText="Keep run"
      disabled={pending}
      focusCancel
      onConfirm={() => {
        if (
          !isCurrentWorkspace() ||
          queryClient.isMutating({ mutationKey, exact: true })
        )
          return;
        confirmed.current = true;
        mutate();
      }}
      onCloseAutoFocus={(event) => {
        if (confirmed.current && focusAfterCancel.current) {
          event.preventDefault();
          focusAfterCancel.current.focus();
        }
        confirmed.current = false;
      }}
      trigger={
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          aria-label={`Cancel run ${name}, ${runId.slice(0, 8)}`}
        >
          {pending ? 'Cancelling…' : 'Cancel run'}
        </Button>
      }
    />
  );
}
