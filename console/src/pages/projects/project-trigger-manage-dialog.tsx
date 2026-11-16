import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type {
  ProjectTriggerDto,
  ProjectTriggerConfigDto,
  UpdateProjectTriggerDto,
} from '@/services/apis/gen/queries';
import { useId, useState, useRef, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ProjectTriggerFilters } from './project-trigger-filters';
import { triggerLabel } from './project-workflow-triggers';
import { useProjectTriggerManage } from './use-project-trigger-create';

type Mode = 'edit' | 'toggle' | 'remove';
const definition = (row: ProjectTriggerDto) =>
  JSON.stringify([row.type, row.cron, row.event, row.enabled, row.config]);
/** Owner controls reuse saved definitions and retain the workspace write guard. */
export function ProjectTriggerManageDialog({
  trigger,
  projectId,
  workspaceId,
  workflowName,
  otherWorkflows,
  focusAfterRemove,
}: {
  trigger: ProjectTriggerDto;
  projectId: string;
  workspaceId: string;
  workflowName: string;
  otherWorkflows: string[];
  focusAfterRemove?: () => void;
}) {
  const launcher = useRef<HTMLButtonElement>(null);
  const [baseline, setBaseline] = useState('');
  const [mode, setMode] = useState<Mode | null>(null),
    id = useId();
  const [cron, setCron] = useState(trigger.cron ?? ''),
    [enabled, setEnabled] = useState(trigger.enabled);
  const [minutes, setMinutes] = useState('10'),
    [max, setMax] = useState('200');
  const [filters, setFilters] = useState<ProjectTriggerConfigDto>({});
  const write = useProjectTriggerManage(
    projectId,
    trigger.projectWorkflowId,
    workspaceId,
    () => {
      setMode(null);
      toast.success('Trigger updated.');
    },
  );
  const changed = mode !== null && baseline !== definition(trigger);
  const title =
    mode === 'edit'
      ? 'Edit trigger'
      : mode === 'remove'
        ? 'Remove trigger'
        : enabled
          ? 'Disable trigger'
          : 'Enable trigger';
  const numbersValid = [
    [minutes, 0, 1440],
    [max, 1, 5000],
  ].every(
    ([raw, min, max]) =>
      String(raw).trim() &&
      Number.isInteger(Number(raw)) &&
      Number(raw) >= Number(min) &&
      Number(raw) <= Number(max),
  );
  const configValid =
    (trigger.event !== 'project.run.completed' ||
      ((filters.status ?? ['success']).length > 0 &&
        (filters.workflows?.length ?? 0) <= 20)) &&
    (trigger.event !== 'vulnerability.detected' ||
      (filters.severity ?? ['critical', 'high']).length > 0);
  const normalizedCron = cron.trim().replace(/\s+/g, ' ');
  const valid =
    mode !== 'edit' ||
    (trigger.type === 'cron'
      ? normalizedCron.split(' ').length === 5
      : numbersValid && configValid);
  function open(next: Mode, button: HTMLButtonElement) {
    if (write.isLocked()) return;
    launcher.current = button;
    setBaseline(definition(trigger));
    write.reset();
    setCron(trigger.cron ?? '');
    setEnabled(trigger.enabled);
    setMinutes(String(trigger.config.windowMinutes ?? 10));
    setMax(String(trigger.config.maxAssets ?? 200));
    setFilters(structuredClone(trigger.config));
    setMode(next);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !mode || changed) return;
    if (mode === 'remove') {
      await write.save({ kind: 'remove', triggerId: trigger.id });
      return;
    }
    let data: UpdateProjectTriggerDto;
    if (mode === 'toggle') data = { enabled: !enabled };
    else if (trigger.type === 'cron') data = { cron: normalizedCron, enabled };
    else
      data = {
        enabled,
        config: {
          ...filters,
          windowMinutes: Number(minutes),
          maxAssets: Number(max),
        },
      };
    await write.save({ kind: 'update', triggerId: trigger.id, data });
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {(['toggle', 'edit', 'remove'] as const).map((action) => {
          const label =
            action === 'toggle'
              ? trigger.enabled
                ? 'Disable'
                : 'Enable'
              : action === 'edit'
                ? 'Edit'
                : 'Remove';
          return (
            <Button
              key={action}
              size="sm"
              variant="outline"
              aria-label={`${label} ${triggerLabel(trigger)} for ${workflowName}`}
              aria-disabled={write.working}
              onClick={(event) => open(action, event.currentTarget)}
            >
              {label}
            </Button>
          );
        })}
      </div>
      <Dialog
        open={mode !== null}
        onOpenChange={(next) => {
          if (!next && !write.isLocked()) setMode(null);
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto [overflow-wrap:anywhere]"
          showCloseButton={!write.working}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (getGlobalWorkspaceId() !== workspaceId) return;
            if (launcher.current?.isConnected) launcher.current.focus();
            else focusAfterRemove?.();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {workflowName} · {triggerLabel(trigger)}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            aria-busy={write.working}
            onSubmit={(e) => void submit(e)}
            onChange={() => {
              if (!write.unknownOutcome) write.reset();
            }}
          >
            {mode === 'toggle' && (
              <p className="text-sm">
                {trigger.enabled
                  ? 'Disable future automatic runs from this trigger.'
                  : 'Enabling this trigger can start scans automatically.'}
              </p>
            )}
            {mode === 'remove' && (
              <p className="text-sm">
                Remove this trigger from the workflow definition?
              </p>
            )}
            {mode === 'edit' && (
              <>
                {trigger.type === 'cron' ? (
                  <Field>
                    <FieldLabel htmlFor={id + '-cron'}>
                      Cron expression (UTC)
                    </FieldLabel>
                    <Input
                      id={id + '-cron'}
                      value={cron}
                      readOnly={write.working}
                      onChange={(e) => setCron(e.target.value)}
                      required
                    />
                  </Field>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {[
                        {
                          key: 'minutes',
                          label: 'Gather for (minutes)',
                          value: minutes,
                          set: setMinutes,
                          min: 0,
                          max: 1440,
                        },
                        {
                          key: 'max',
                          label: 'Most assets per batch',
                          value: max,
                          set: setMax,
                          min: 1,
                          max: 5000,
                        },
                      ].map((field) => (
                        <Field key={field.key}>
                          <FieldLabel htmlFor={id + field.key}>
                            {field.label}
                          </FieldLabel>
                          <Input
                            id={id + field.key}
                            type="number"
                            min={field.min}
                            max={field.max}
                            step={1}
                            required
                            value={field.value}
                            readOnly={write.working}
                            onChange={(e) => field.set(e.target.value)}
                          />
                        </Field>
                      ))}
                    </div>
                    {trigger.event && (
                      <ProjectTriggerFilters
                        event={trigger.event}
                        value={filters}
                        disabled={write.working}
                        otherWorkflows={otherWorkflows}
                        onChange={(patch) => {
                          setFilters((previous) => ({ ...previous, ...patch }));
                          if (!write.unknownOutcome) write.reset();
                        }}
                      />
                    )}
                  </>
                )}
                <Field orientation="horizontal">
                  <Checkbox
                    id={id + '-enabled'}
                    checked={enabled}
                    disabled={write.working}
                    onCheckedChange={(value) => setEnabled(value === true)}
                  />
                  <FieldLabel htmlFor={id + '-enabled'}>Enabled</FieldLabel>
                </Field>
                <p className="text-sm text-muted-foreground">
                  Enabled triggers can start scans automatically.
                </p>
              </>
            )}
            {changed && !write.working && !write.unknownOutcome && (
              <p role="alert" className="text-sm text-destructive">
                This trigger changed while the dialog was open. Close and reopen
                to use its latest settings.
              </p>
            )}
            {write.isError && (
              <p role="alert" className="text-sm text-destructive">
                {write.unknownOutcome
                  ? 'The change may have been saved. Close and check the refreshed triggers before trying again.'
                  : 'Could not update this trigger. Check the settings and your project access.'}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={write.working}
                onClick={() => setMode(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={mode === 'remove' ? 'destructive' : 'default'}
                disabled={!valid || changed}
                aria-disabled={write.working || write.unknownOutcome}
              >
                {write.working
                  ? 'Saving…'
                  : mode === 'edit'
                    ? 'Save trigger'
                    : title}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
