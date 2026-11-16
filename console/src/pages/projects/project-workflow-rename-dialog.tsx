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
import { type FormEvent, useId, useState } from 'react';
import { useProjectWorkflowSave } from './use-project-workflow-save';
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
  const inputId = useId();
  const update = useProjectWorkflowSave(projectId, workspaceId);
  const { saving } = update;
  const conflict = open && !saving && workflowName !== baseline;
  const value = draft.trim();
  const canSave =
    value.length > 0 &&
    [...value].length <= 120 &&
    value !== baseline.trim() &&
    !conflict;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    await update.save(bindingId, { name: value }, () => {
      setOpen(false);
      toast.success('Workflow renamed.');
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (update.isLocked()) return;
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
