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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ProjectTriggerEvent } from '@/services/apis/gen/queries';
import { type FormEvent, useId, useState } from 'react';
import { toast } from 'sonner';
import { useProjectTriggerCreate } from './use-project-trigger-create';

const events: Record<ProjectTriggerEvent, { label: string; hint: string }> = {
  'project.assets.added': {
    label: 'When assets are added',
    hint: 'New assets of any type are included.',
  },
  'project.run.completed': {
    label: 'After a project workflow finishes',
    hint: 'Any other project workflow succeeds: include the assets it scanned.',
  },
  'vulnerability.detected': {
    label: 'When a vulnerability is found',
    hint: 'Critical and high findings: include their assets. This workflow’s own findings are excluded.',
  },
};

/** Save one disabled event definition using the existing trigger write guards. */
export function ProjectTriggerEventDialog({
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
  const [event, setEvent] = useState<ProjectTriggerEvent>(
    'project.assets.added',
  );
  const [windowMinutes, setWindowMinutes] = useState('10');
  const [maxAssets, setMaxAssets] = useState('200');
  const id = useId();
  const create = useProjectTriggerCreate(
    projectId,
    bindingId,
    workspaceId,
    () => {
      setOpen(false);
      toast.success('Event trigger added disabled.');
    },
  );
  const { creating, unknownOutcome, archived } = create;
  const fields = [
    {
      key: 'window',
      label: 'Gather for (minutes)',
      min: 0,
      max: 1440,
      value: windowMinutes,
      set: setWindowMinutes,
    },
    {
      key: 'max',
      label: 'Most assets per batch',
      min: 1,
      max: 5000,
      value: maxAssets,
      set: setMaxAssets,
    },
  ];
  const valid = fields.every(
    ({ value, min, max }) =>
      value.trim() !== '' &&
      Number.isInteger(Number(value)) &&
      Number(value) >= min &&
      Number(value) <= max,
  );

  /** Reject incomplete numbers before the shared hook dispatches one request. */
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) return;
    await create.save({
      type: 'event',
      event,
      config: {
        windowMinutes: Number(windowMinutes),
        maxAssets: Number(maxAssets),
      },
    });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (create.isLocked()) return;
        if (next) {
          setEvent('project.assets.added');
          setWindowMinutes('10');
          setMaxAssets('200');
          create.reset();
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Add event trigger for ${workflowName}`}
          aria-disabled={creating}
        >
          {creating ? 'Adding trigger…' : 'Add event trigger'}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto [overflow-wrap:anywhere]"
        showCloseButton={!creating}
      >
        <DialogHeader>
          <DialogTitle>Add event trigger</DialogTitle>
          <DialogDescription>
            The new trigger for {workflowName} is saved disabled.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          aria-busy={creating}
          onSubmit={(e) => void submit(e)}
          onChange={() => {
            if (!unknownOutcome) create.reset();
          }}
        >
          <Field>
            <FieldLabel htmlFor={id + '-event'}>Event</FieldLabel>
            <select
              id={id + '-event'}
              value={event}
              disabled={creating}
              aria-describedby={id + '-hint'}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-50"
              onChange={(e) => setEvent(e.target.value as ProjectTriggerEvent)}
            >
              {Object.entries(events).map(([value, option]) => (
                <option key={value} value={value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p id={id + '-hint'} className="text-sm text-muted-foreground">
              {events[event].hint}
            </p>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <Field key={field.key}>
                <FieldLabel htmlFor={id + '-' + field.key}>
                  {field.label}
                </FieldLabel>
                <Input
                  id={id + '-' + field.key}
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={1}
                  required
                  readOnly={creating}
                  value={field.value}
                  onChange={(e) => field.set(e.target.value)}
                />
              </Field>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Events within the gather window form a batch; larger batches split
            at the asset limit.
          </p>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {unknownOutcome
                ? 'The event trigger may have been added. Close this dialog and check the trigger list before trying again.'
                : archived
                  ? 'This project is archived. Event triggers cannot be added.'
                  : 'Could not add event trigger. Check the settings, existing triggers and your access.'}
            </p>
          )}
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
