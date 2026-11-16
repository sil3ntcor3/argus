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
import { type FormEvent, useId, useState } from 'react';
import { toast } from 'sonner';
import { useProjectTriggerCreate } from './use-project-trigger-create';

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
  const cron = draft.trim().replace(/\s+/g, ' ');
  const valid = cron.split(' ').length === 5;
  const create = useProjectTriggerCreate(projectId, bindingId, workspaceId, () => {
    setOpen(false);
    toast.success('Schedule trigger added disabled.');
  });
  const { creating, unknownOutcome, archived } = create;

  /** Submit once; an uncertain outcome requires checking the refreshed list. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    await create.save({ type: 'cron', cron });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (create.isLocked()) return;
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
