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
  assetGroupControllerUpdateAssetGroupWorkflow,
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  type ProjectViewDto,
  projectsControllerGetById,
  useAssetGroupControllerUpdateAssetGroupWorkflow,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';

class ScheduleChanged extends Error {
  readonly schedule: string;

  constructor(schedule: string) {
    super('Schedule changed');
    this.schedule = schedule;
  }
}

function normalizeSchedule(schedule: string) {
  return schedule.trim().replace(/\s+/g, ' ');
}

export function ProjectWorkflowScheduleDialog({
  projectId,
  bindingId,
  workflowName,
  schedule,
  workspaceId,
}: {
  projectId: string;
  bindingId: string;
  workflowName: string;
  schedule: string;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState(schedule);
  const [draft, setDraft] = useState(schedule);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const key = getProjectsControllerGetByIdQueryKey(projectId);
  const legacyKey = getAssetGroupControllerGetByIdQueryKey(projectId);
  const update = useAssetGroupControllerUpdateAssetGroupWorkflow({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: async ({ id, data }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        const project = await projectsControllerGetById(projectId, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        const binding = project.assetGroupWorkflows?.find(
          (item) => item.id === id,
        );
        if (!binding || binding.schedule !== baseline) {
          await writeProjectCache(() => project);
          if (!binding) throw new Error('The workflow assignment changed');
          throw new ScheduleChanged(binding.schedule);
        }
        return assetGroupControllerUpdateAssetGroupWorkflow(id, data);
      },
    },
  });
  const conflict =
    update.error instanceof ScheduleChanged ? update.error : null;
  const invalid =
    isAxiosError(update.error) && update.error.response?.status === 400;
  const value = normalizeSchedule(draft);
  const canSave =
    !conflict &&
    value !== normalizeSchedule(baseline) &&
    (value === 'disabled' || value.split(' ').length === 5);

  async function writeProjectCache(
    updateCache: (previous?: ProjectViewDto) => ProjectViewDto | undefined,
  ) {
    if (workspaceId !== getGlobalWorkspaceId()) return;
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    if (workspaceId === getGlobalWorkspaceId())
      queryClient.setQueryData(key, updateCache);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || lock.current || workspaceId !== getGlobalWorkspaceId())
      return;
    lock.current = true;
    setSaving(true);
    try {
      const result = await update
        .mutateAsync({
          id: bindingId,
          data: { schedule: value },
        })
        .catch(() => undefined);
      if (!result) return;
      await writeProjectCache(
        (project) =>
          project && {
            ...project,
            assetGroupWorkflows: project.assetGroupWorkflows?.map((binding) =>
              binding.id === result.id
                ? { ...binding, schedule: result.schedule }
                : binding,
            ),
          },
      );
      await queryClient.invalidateQueries({
        predicate: ({ queryKey: [path] }) =>
          typeof path === 'string' &&
          (path.toLowerCase() === key[0] ||
            path.toLowerCase() === legacyKey[0]),
        refetchType: workspaceId === getGlobalWorkspaceId() ? 'active' : 'none',
      });
      if (workspaceId !== getGlobalWorkspaceId()) return;
      setOpen(false);
      toast.success('Workflow schedule saved.');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  function edit(value: string) {
    setDraft(value);
    if (update.isError && !conflict) update.reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (lock.current) return;
        if (next) {
          setBaseline(schedule);
          setDraft(schedule);
          update.reset();
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Edit schedule for ${workflowName}`}
        >
          Edit schedule
        </Button>
      </DialogTrigger>
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>Edit workflow schedule</DialogTitle>
          <DialogDescription>
            Set a five-field UTC cron expression for {workflowName}. Use
            disabled to turn off scheduled runs.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          aria-busy={saving}
          onSubmit={(event) => void submit(event)}
        >
          <div className="space-y-2">
            <Label htmlFor={`workflow-schedule-${bindingId}`}>
              Cron schedule (UTC)
            </Label>
            <Input
              ref={input}
              id={`workflow-schedule-${bindingId}`}
              value={draft}
              placeholder="0 8 * * *"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              readOnly={saving}
              aria-invalid={invalid}
              className="font-mono focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => edit(event.target.value)}
            />
          </div>
          {update.isError && (
            <p role="alert">
              {conflict
                ? 'Schedule changed. Load the saved schedule before editing again.'
                : invalid
                  ? 'Enter a valid five-field cron expression or disabled.'
                  : 'Unable to save the workflow schedule. Try again.'}
            </p>
          )}
          {conflict ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                input.current?.focus();
                setBaseline(conflict.schedule);
                setDraft(conflict.schedule);
                update.reset();
              }}
            >
              Load saved schedule
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              disabled={saving || value === 'disabled'}
              onClick={() => {
                input.current?.focus();
                edit('disabled');
              }}
            >
              Disable schedule
            </Button>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              aria-disabled={saving}
              onClick={() => {
                if (!lock.current) setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} aria-disabled={saving}>
              {saving ? 'Saving…' : 'Save schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
