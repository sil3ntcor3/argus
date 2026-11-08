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
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  getProjectsControllerGetOverviewQueryKey,
  projectsControllerCreateWorkflow,
  useProjectsControllerCreateWorkflow,
  useProjectsControllerGetWorkflowTemplates,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { type FormEvent, useId, useState } from 'react';
import { toast } from 'sonner';

/** A transport or upstream error can arrive after the server commits. */
function mayHaveCreated(error: unknown): boolean {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined || status === 408 || status >= 500;
}

/** Copies a workspace template into a project as a disabled assignment. */
export function ProjectWorkflowCreateDialog({
  projectId,
  workspaceId,
}: {
  projectId: string;
  workspaceId: string;
}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const mutationKey = ['create-project-workflow', workspaceId, projectId];
  const mutationFilter = { mutationKey, exact: true };
  const creating = useIsMutating(mutationFilter) > 0;
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState('');
  const [name, setName] = useState('');
  const templates = useProjectsControllerGetWorkflowTemplates({
    query: { enabled: open, retry: false, networkMode: 'always' },
  });

  /** Refresh project views without refetching under another workspace. */
  async function refreshAssignments() {
    const refetchType =
      workspaceId === getGlobalWorkspaceId() ? 'active' : 'none';
    await Promise.all(
      [
        getProjectsControllerGetByIdQueryKey(projectId),
        getProjectsControllerGetOverviewQueryKey(projectId),
        getAssetGroupControllerGetByIdQueryKey(projectId),
        getProjectsControllerGetManyQueryKey(),
      ].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey, refetchType }),
      ),
    );
  }

  const create = useProjectsControllerCreateWorkflow({
    mutation: {
      mutationKey,
      retry: false,
      networkMode: 'always',
      mutationFn: async ({ id, data }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        return projectsControllerCreateWorkflow(id, data);
      },
      onSuccess: async () => {
        if (workspaceId === getGlobalWorkspaceId()) {
          setOpen(false);
          toast.success('Project workflow created.');
        }
        await refreshAssignments();
      },
      onError: async (error) => {
        if (mayHaveCreated(error)) await refreshAssignments();
      },
    },
  });
  const catalog = templates.data ?? [];
  const uncertain = create.isError && mayHaveCreated(create.error);
  const message = isAxiosError<{ message?: unknown }>(create.error)
    ? create.error.response?.data?.message
    : undefined;
  const catalogReady = !templates.isFetching && !templates.isError;
  const canSubmit =
    catalogReady &&
    catalog.some((item) => item.filePath === template) &&
    !uncertain &&
    !creating;

  /** Clear draft data on open and keep the dialog open through submission. */
  function changeOpen(next: boolean) {
    if (queryClient.isMutating(mutationFilter)) return;
    if (next) {
      setTemplate('');
      setName('');
      create.reset();
    }
    setOpen(next);
  }

  /** Submit one scoped request and render failures from the mutation state. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canSubmit ||
      queryClient.isMutating(mutationFilter) ||
      workspaceId !== getGlobalWorkspaceId()
    )
      return;
    const trimmedName = name.trim();
    try {
      await create.mutateAsync({
        id: projectId,
        data: { template, ...(trimmedName ? { name: trimmedName } : {}) },
      });
    } catch {
      // The mutation error is shown next to the form.
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          aria-disabled={creating}
          className="aria-disabled:opacity-50"
        >
          {creating ? 'Creating workflow…' : 'Create workflow'}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!creating}>
        <DialogHeader>
          <DialogTitle>Create project workflow</DialogTitle>
          <DialogDescription>
            Copy a default workflow template into this project. Its schedule
            starts disabled.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor={formId + '-template'}>Workflow template</Label>
            <select
              id={formId + '-template'}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-50"
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              required
              disabled={
                !catalogReady ||
                !catalog.length ||
                create.isPending ||
                uncertain
              }
            >
              <option value="">Select a template</option>
              {catalog.map((item) => (
                <option key={item.filePath} value={item.filePath}>
                  {item.name}
                </option>
              ))}
            </select>
            {templates.isFetching ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading workflow templates…
              </p>
            ) : templates.isError ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm" role="status">
                  Unable to load workflow templates
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void templates.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : catalog.length === 0 ? (
              <p className="text-sm text-muted-foreground" role="status">
                No default workflow templates are available.
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={formId + '-name'}>Workflow name (optional)</Label>
            <Input
              id={formId + '-name'}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Use the template name"
              maxLength={120}
              readOnly={creating || uncertain}
            />
          </div>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {uncertain
                ? 'The server may have created the workflow. Close this dialog and check the assignments before trying again.'
                : typeof message === 'string' && message
                  ? message
                  : 'Unable to create the workflow. Check the template and try again.'}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              aria-disabled={creating}
              className="aria-disabled:opacity-50"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit && !creating && !uncertain}
              aria-disabled={creating || uncertain}
              className="aria-disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create workflow'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
