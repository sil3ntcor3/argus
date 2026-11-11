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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  getAssetGroupControllerGetAllQueryKey,
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  projectsControllerDelete,
  useProjectsControllerDelete,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export function ProjectDeleteDialog({
  projectId,
  projectName,
  workspaceId,
  disabled = false,
}: {
  projectId: string;
  projectName: string;
  workspaceId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const lock = useRef(false);
  const active = useRef(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useProjectsControllerDelete({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: async ({ id }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        return projectsControllerDelete(id);
      },
    },
  });

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      confirmation !== 'delete' ||
      disabled ||
      lock.current ||
      workspaceId !== getGlobalWorkspaceId()
    )
      return;

    lock.current = true;
    setDeleting(true);
    try {
      const result = await remove
        .mutateAsync({ id: projectId })
        .catch(() => undefined);
      if (!result) return;
      const refetchType =
        workspaceId === getGlobalWorkspaceId() ? 'active' : 'none';
      await Promise.all(
        [
          getProjectsControllerGetManyQueryKey(),
          getAssetGroupControllerGetAllQueryKey(),
          ['asset-group'],
        ].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey, refetchType }),
        ),
      );
      try {
        if (active.current && workspaceId === getGlobalWorkspaceId()) {
          setOpen(false);
          toast.success('Project deleted.');
          await navigate({ to: '/projects', replace: true });
        }
      } finally {
        const paths = [
          getProjectsControllerGetByIdQueryKey(projectId)[0],
          getAssetGroupControllerGetByIdQueryKey(projectId)[0],
        ];
        queryClient.removeQueries({
          predicate: ({ queryKey: [path] }) => {
            if (typeof path !== 'string') return false;
            const normalized = path.toLowerCase();
            return paths.some(
              (root) =>
                normalized === root || normalized.startsWith(root + '/'),
            );
          },
        });
      }
    } finally {
      lock.current = false;
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (lock.current) return;
        if (next) {
          setConfirmation('');
          remove.reset();
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>
          Delete project
        </Button>
      </DialogTrigger>
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={!deleting}
      >
        <DialogHeader>
          <DialogTitle>Delete project</DialogTitle>
          <DialogDescription>
            Permanently delete {projectName}? This removes project membership,
            saved scope, schedules, and project finding history. Workflows
            generated for this project may be deleted with their run history.
            Shared workflows, workspace assets, and findings remain in the
            workspace.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          aria-busy={deleting}
          onSubmit={(event) => void submit(event)}
        >
          <div className="space-y-2">
            <Label htmlFor="project-delete-confirmation">
              Type delete to confirm
            </Label>
            <Input
              id="project-delete-confirmation"
              value={confirmation}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              readOnly={deleting}
              className="focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          {remove.isError && (
            <p role="alert">Unable to delete the project. Try again.</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              aria-disabled={deleting}
              className="aria-disabled:opacity-50"
              onClick={() => {
                if (!lock.current) setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={confirmation !== 'delete'}
              aria-disabled={deleting}
              className="aria-disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
