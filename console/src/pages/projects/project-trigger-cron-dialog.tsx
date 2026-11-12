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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetTriggersQueryKey,
  projectsControllerCreateTrigger,
  useProjectsControllerCreateTrigger,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { type FormEvent, useId, useState } from 'react';
import { toast } from 'sonner';

/** A response can be lost after the trigger and its file definition are saved. */
function uncertain(error: unknown) {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined || status === 408 || status >= 500;
}

/** Add a disabled cron definition while retaining the binding's legacy schedule. */
export function ProjectTriggerCronDialog({
  projectId,
  bindingId,
  workflowName,
  workspaceId,
}: {
  projectId: string;
  bindingId: string;
  workflowName: string;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const client = useQueryClient();
  const mutationKey = [
    'create-project-trigger',
    workspaceId,
    projectId,
    bindingId,
  ];
  const filter = { mutationKey, exact: true };
  const creating = useIsMutating(filter) > 0;
  const cron = draft.trim().replace(/\s+/g, ' ');
  const valid = cron.split(' ').length === 5;

  /** Mark original views stale without fetching them under another workspace. */
  async function refresh() {
    const paths: string[] = [
      getProjectsControllerGetByIdQueryKey(projectId)[0],
      getProjectsControllerGetTriggersQueryKey(projectId)[0],
      getAssetGroupControllerGetByIdQueryKey(projectId)[0],
    ];
    await client.invalidateQueries({
      predicate: ({ queryKey: [path] }) =>
        typeof path === 'string' && paths.includes(path.toLowerCase()),
      refetchType: getGlobalWorkspaceId() === workspaceId ? 'active' : 'none',
    });
  }
  const create = useProjectsControllerCreateTrigger({
    mutation: {
      mutationKey,
      retry: false,
      networkMode: 'always',
      mutationFn: ({ id, data }) => {
        if (getGlobalWorkspaceId() !== workspaceId)
          throw new Error('The selected workspace changed');
        return projectsControllerCreateTrigger(id, data);
      },
      onSuccess: async () => {
        await refresh();
        if (getGlobalWorkspaceId() !== workspaceId) return;
        setOpen(false);
        toast.success('Schedule trigger added disabled.');
      },
      onError: async (error) => {
        if (uncertain(error)) await refresh();
      },
    },
  });
  const unknownOutcome = create.isError && uncertain(create.error);
  const archived =
    isAxiosError<{ message?: string }>(create.error) &&
    create.error.response?.status === 400 &&
    create.error.response.data?.message === 'Project is archived';

  /** Submit once; an uncertain outcome requires checking the refreshed list. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !valid ||
      unknownOutcome ||
      client.isMutating(filter) ||
      getGlobalWorkspaceId() !== workspaceId
    )
      return;
    try {
      await create.mutateAsync({
        id: projectId,
        data: { projectWorkflowId: bindingId, type: 'cron', cron },
      });
    } catch {
      /* Render the mutation outcome beside the input. */
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (client.isMutating(filter)) return;
        if (next) {
          setDraft('');
          create.reset();
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Add schedule trigger for ${workflowName}`}
          aria-disabled={creating}
        >
          {creating ? 'Adding trigger…' : 'Add schedule trigger'}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={!creating}
      >
        <DialogHeader>
          <DialogTitle>Add schedule trigger</DialogTitle>
          <DialogDescription>
            The new trigger for {workflowName} is saved disabled. Use five UTC
            fields: minute, hour, day, month, weekday.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          aria-busy={creating}
        >
          <Field data-invalid={create.isError || undefined}>
            <FieldLabel htmlFor={inputId}>Cron expression (UTC)</FieldLabel>
            <Input
              id={inputId}
              value={draft}
              placeholder="0 8 * * *"
              className="font-mono"
              required
              readOnly={creating}
              aria-invalid={create.isError}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setDraft(event.target.value);
                if (!unknownOutcome) create.reset();
              }}
            />
            {create.isError && (
              <FieldError>
                {unknownOutcome
                  ? 'The schedule may have been added. Close this dialog and check the trigger list before trying again.'
                  : archived
                    ? 'This project is archived. Schedule triggers cannot be added.'
                    : 'Could not add schedule. Check the expression and your access.'}
              </FieldError>
            )}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!valid}
              aria-disabled={creating || unknownOutcome}
            >
              {creating ? 'Adding…' : 'Add disabled trigger'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
