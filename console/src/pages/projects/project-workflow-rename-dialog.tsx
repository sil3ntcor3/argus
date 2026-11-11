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
  projectsControllerUpdateWorkflow,
  useProjectsControllerUpdateWorkflow,
  type ProjectViewDto,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

/** Rename an owned workflow through the selected workspace's project API. */
export function ProjectWorkflowRenameDialog({
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
  const [draft, setDraft] = useState(workflowName);
  const [baseline, setBaseline] = useState(workflowName);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const inputId = useId();
  const client = useQueryClient();
  const key = getProjectsControllerGetByIdQueryKey(projectId);
  const legacyKey = getAssetGroupControllerGetByIdQueryKey(projectId);
  const update = useProjectsControllerUpdateWorkflow({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: ({ id, bindingId, data }) => {
        if (getGlobalWorkspaceId() !== workspaceId)
          throw new Error('The selected workspace changed');
        return projectsControllerUpdateWorkflow(id, bindingId, data);
      },
    },
  });
  const conflict = open && !saving && workflowName !== baseline;
  const value = draft.trim();
  const canSave =
    value.length > 0 &&
    [...value].length <= 120 &&
    value !== baseline.trim() &&
    !conflict;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || lock.current || getGlobalWorkspaceId() !== workspaceId)
      return;
    lock.current = true;
    setSaving(true);
    try {
      const result = await update
        .mutateAsync({ id: projectId, bindingId, data: { name: value } })
        .catch(() => undefined);
      if (!result || getGlobalWorkspaceId() !== workspaceId) return;
      await client.cancelQueries({ queryKey: key, exact: true });
      if (getGlobalWorkspaceId() !== workspaceId) return;
      client.setQueryData<ProjectViewDto>(
        key,
        (project) =>
          project && {
            ...project,
            assetGroupWorkflows: project.assetGroupWorkflows?.map((binding) =>
              binding.id === result.id ? { ...binding, ...result } : binding,
            ),
          },
      );
      await client.invalidateQueries({
        predicate: ({ queryKey: [path] }) =>
          typeof path === 'string' &&
          (path.toLowerCase() === key[0] ||
            path.toLowerCase() === legacyKey[0]),
        refetchType: getGlobalWorkspaceId() === workspaceId ? 'active' : 'none',
      });
      if (getGlobalWorkspaceId() !== workspaceId) return;
      setOpen(false);
      toast.success('Workflow renamed.');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (lock.current) return;
        if (next) {
          setDraft(workflowName);
          setBaseline(workflowName);
          update.reset();
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Rename workflow ${workflowName}`}
        >
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>Rename workflow</DialogTitle>
          <DialogDescription>
            Use 1–120 characters for the workflow name.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor={inputId}>Workflow name</Label>
            <Input
              id={inputId}
              autoFocus
              required
              value={draft}
              disabled={saving}
              onChange={(event) => {
                setDraft(event.target.value);
                if (update.isError) update.reset();
              }}
            />
          </div>
          {(conflict || update.isError) && (
            <p role="alert" className="text-sm text-destructive">
              {conflict
                ? `Name changed to ${workflowName}. Close and reopen to edit it.`
                : 'Could not rename this workflow. Try again.'}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || saving}>
              {saving ? 'Saving…' : 'Save name'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
