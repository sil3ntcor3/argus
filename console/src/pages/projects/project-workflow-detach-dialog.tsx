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
  assetGroupControllerRemoveManyWorkflows,
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  projectsControllerGetById,
  type ProjectViewDto,
  useAssetGroupControllerRemoveManyWorkflows,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

class AssignmentChanged extends Error {}

export function ProjectWorkflowDetachDialog({
  projectId,
  bindingId,
  workflowId,
  workflowName,
  workspaceId,
  focusAssignments,
}: {
  projectId: string;
  bindingId: string;
  workflowId: string;
  workflowName: string;
  workspaceId: string;
  focusAssignments: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const lock = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const detailKey = getProjectsControllerGetByIdQueryKey(projectId);
  const remove = useAssetGroupControllerRemoveManyWorkflows({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: async ({ groupId, data }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        const project = await projectsControllerGetById(groupId, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        const isCurrent = project.assetGroupWorkflows?.some(
          (binding) =>
            binding.id === bindingId && binding.workflow?.id === workflowId,
        );
        if (!isCurrent) throw new AssignmentChanged();
        return assetGroupControllerRemoveManyWorkflows(groupId, data);
      },
    },
  });
  const stale = remove.error instanceof AssignmentChanged;

  function changeOpen(next: boolean) {
    if (lock.current) return;
    if (next) remove.reset();
    else if (stale && workspaceId === getGlobalWorkspaceId())
      void queryClient.invalidateQueries({ queryKey: detailKey });
    setOpen(next);
  }

  async function detach() {
    if (stale || lock.current || workspaceId !== getGlobalWorkspaceId()) return;
    lock.current = true;
    setDetaching(true);
    try {
      const result = await remove
        .mutateAsync({
          groupId: projectId,
          data: { workflowIds: [workflowId] },
        })
        .catch(() => undefined);
      if (!result) return;
      if (workspaceId === getGlobalWorkspaceId()) {
        await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
        if (workspaceId === getGlobalWorkspaceId()) {
          setOpen(false);
          queryClient.setQueryData<ProjectViewDto>(
            detailKey,
            (project) =>
              project && {
                ...project,
                assetGroupWorkflows: project.assetGroupWorkflows?.filter(
                  (binding) => binding.id !== bindingId,
                ),
              },
          );
          toast.success('Workflow detached.');
        }
      }
      const legacy = getAssetGroupControllerGetByIdQueryKey(projectId)[0];
      const root = detailKey[0];
      const refetchType =
        workspaceId === getGlobalWorkspaceId() ? 'active' : 'none';
      await Promise.all([
        queryClient.invalidateQueries({
          predicate: ({ queryKey: [path] }) => {
            if (typeof path !== 'string') return false;
            const resource = path.toLowerCase();
            return (
              resource === legacy ||
              resource === root ||
              resource.startsWith(root + '/')
            );
          },
          refetchType,
        }),
        queryClient.invalidateQueries({
          queryKey: getProjectsControllerGetManyQueryKey(),
          refetchType,
        }),
      ]);
    } finally {
      lock.current = false;
      setDetaching(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          ref={trigger}
          variant="outline"
          size="sm"
          aria-label={`Detach workflow ${workflowName}`}
        >
          Detach workflow
        </Button>
      </DialogTrigger>
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={!detaching}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.current?.isConnected) trigger.current.focus();
          else focusAssignments();
        }}
      >
        <DialogHeader>
          <DialogTitle>Detach project workflow</DialogTitle>
          <DialogDescription>
            Detach {workflowName} from this project? Its project schedule stops.
            The workflow definition and past runs remain. Filters for this
            assignment are removed from Runs and Findings.
          </DialogDescription>
        </DialogHeader>
        {remove.isError && (
          <p role="alert">
            {stale
              ? 'Workflow assignment changed. Close this dialog to refresh.'
              : 'Unable to detach the workflow. Try again.'}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            aria-disabled={detaching}
            className="aria-disabled:opacity-50"
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={stale}
            aria-disabled={detaching}
            className="aria-disabled:opacity-50"
            onClick={() => void detach()}
          >
            {detaching ? 'Detaching…' : 'Detach workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
