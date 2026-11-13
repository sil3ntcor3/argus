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
  projectsControllerRemoveWorkflow,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  getAssetGroupControllerGetByIdQueryKey,
} from '@/services/apis/gen/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useProjectWorkflowAction } from './use-project-workflow-action';

export function ProjectWorkflowDetachDialog({
  projectId,
  bindingId,
  workflowName,
  workspaceId,
  focusAssignments,
}: {
  projectId: string;
  bindingId: string;
  workflowName: string;
  workspaceId: string;
  focusAssignments: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const remove = useProjectWorkflowAction(
    workspaceId,
    projectId,
    bindingId,
    'remove',
  );
  const detaching = remove.busy;
  const detailKey = getProjectsControllerGetByIdQueryKey(projectId);
  function changeOpen(next: boolean) {
    if (!remove.isLocked()) setOpen(next);
  }
  async function detach() {
    const result = await remove.execute((signal) =>
      projectsControllerRemoveWorkflow(projectId, bindingId, {
        signal,
        timeout: 30_000,
        headers: { 'X-Workspace-Id': workspaceId },
      }),
    );
    if (!result || !remove.current()) return;
    setOpen(false);
    toast.success('Workflow removed.');
    const legacy = getAssetGroupControllerGetByIdQueryKey(projectId)[0];
    const root = detailKey[0];
    await Promise.all([
      queryClient.invalidateQueries({
        predicate: ({ queryKey: [path] }) =>
          typeof path === 'string' &&
          (path === legacy || path === root || path.startsWith(root + '/')),
      }),
      queryClient.invalidateQueries({
        queryKey: getProjectsControllerGetManyQueryKey(),
      }),
    ]);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          ref={trigger}
          variant="outline"
          size="sm"
          aria-label={`Remove workflow ${workflowName}`}
        >
          Remove workflow
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
          <DialogTitle>Remove project workflow</DialogTitle>
          <DialogDescription>
            Remove {workflowName} and stop its project triggers and schedule? An
            exclusively owned workflow and its runs and jobs will be deleted.
            Shared workflow definitions remain. Findings are retained.
          </DialogDescription>
        </DialogHeader>
        {(remove.error || remove.uncertain) && (
          <p role="alert">
            {remove.uncertain
              ? 'Could not confirm removal. Refresh the workflow list before making another request.'
              : remove.error}
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
          {remove.uncertain && (
            <Button
              variant="outline"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: detailKey });
                void queryClient.invalidateQueries({
                  queryKey: [detailKey[0] + '/workflows'],
                });
                remove.acknowledge();
              }}
            >
              I checked the list; allow a new request
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={remove.uncertain}
            aria-disabled={detaching}
            className="aria-disabled:opacity-50"
            onClick={() => void detach()}
          >
            {detaching ? 'Removing…' : 'Remove workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
