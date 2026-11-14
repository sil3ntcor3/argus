import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
  ProjectWorkflowOnDto,
  ProjectTriggerEvent,
} from '@/services/apis/gen/queries';
import { ProjectTriggerFilters } from './project-trigger-filters';

export const creationEvents: Record<ProjectTriggerEvent, string> = {
  'project.assets.added': 'When assets are added',
  'project.run.completed': 'After a project workflow finishes',
  'vulnerability.detected': 'When a vulnerability is found',
};

/** Validate visible numeric drafts before emitting JSON and activating a trigger. */
export function creationTriggersValid(on: ProjectWorkflowOnDto) {
  return (
    (on.schedule ?? []).every((t) => t.cron.trim().split(/\s+/).length === 5) &&
    (on.events ?? []).every(
      (t) =>
        Number.isInteger(t.windowMinutes ?? 10) &&
        (t.windowMinutes ?? 10) >= 0 &&
        (t.windowMinutes ?? 10) <= 1440 &&
        Number.isInteger(t.maxAssets ?? 200) &&
        (t.maxAssets ?? 200) >= 1 &&
        (t.maxAssets ?? 200) <= 5000 &&
        (t.event !== 'project.run.completed' ||
          ((t.status ?? ['success']).length > 0 &&
            (t.workflows?.length ?? 0) <= 20)) &&
        (t.event !== 'vulnerability.detected' ||
          (t.severity ?? ['critical', 'high']).length > 0),
    )
  );
}

/** Reuse event filter controls while keeping all definitions in the create draft. */
export function ProjectCreateTriggers({
  value,
  onChange,
  canLaunch,
  disabled,
}: {
  value: ProjectWorkflowOnDto;
  onChange: (value: ProjectWorkflowOnDto) => void;
  canLaunch: boolean;
  disabled: boolean;
}) {
  const schedules = value.schedule ?? [],
    events = value.events ?? [];
  return (
    <section
      aria-labelledby="create-project-triggers-heading"
      className="space-y-4 rounded-xl border bg-card p-4"
    >
      <h2 id="create-project-triggers-heading" className="font-semibold">
        Workflow triggers
      </h2>
      <p className="text-sm text-muted-foreground">
        Leave empty for manual launch. New definitions are saved disabled unless
        you enable them.
      </p>
      {!canLaunch && (
        <p className="text-sm text-muted-foreground">
          Your access allows saving definitions disabled. Launch access is
          required to enable them.
        </p>
      )}
      {schedules.map((schedule, index) => (
        <fieldset
          key={index}
          disabled={disabled}
          className="space-y-3 rounded-md border p-3"
        >
          <legend className="px-1 text-sm font-medium">
            Schedule {index + 1}
          </legend>
          <label className="block text-sm">
            Cron expression {index + 1} (UTC)
            <Input
              required
              spellCheck={false}
              placeholder="0 8 * * *"
              value={schedule.cron}
              onChange={(e) =>
                onChange({
                  ...value,
                  schedule: schedules.map((t, i) =>
                    i === index ? { ...t, cron: e.target.value } : t,
                  ),
                })
              }
            />
          </label>
          {canLaunch && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={schedule.enabled ?? false}
                onChange={(e) =>
                  onChange({
                    ...value,
                    schedule: schedules.map((t, i) =>
                      i === index ? { ...t, enabled: e.target.checked } : t,
                    ),
                  })
                }
              />
              Enable schedule {index + 1}
            </label>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              onChange({
                ...value,
                schedule: schedules.filter((_, i) => i !== index),
              })
            }
          >
            Remove schedule {index + 1}
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || schedules.length >= 20}
        onClick={() =>
          onChange({
            ...value,
            schedule: [...schedules, { cron: '', enabled: false }],
          })
        }
      >
        Add schedule
      </Button>
      {events.map((event, index) => (
        <fieldset
          key={event.event}
          disabled={disabled}
          className="space-y-3 rounded-md border p-3"
        >
          <legend className="px-1 text-sm font-medium">
            {creationEvents[event.event]}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Gather for (minutes)
              <Input
                required
                type="number"
                min={0}
                max={1440}
                step={1}
                value={
                  Number.isFinite(event.windowMinutes ?? 10)
                    ? (event.windowMinutes ?? 10)
                    : ''
                }
                onChange={(e) =>
                  onChange({
                    ...value,
                    events: events.map((t, i) =>
                      i === index
                        ? { ...t, windowMinutes: e.target.valueAsNumber }
                        : t,
                    ),
                  })
                }
              />
            </label>
            <label className="text-sm">
              Most assets per batch
              <Input
                required
                type="number"
                min={1}
                max={5000}
                step={1}
                value={
                  Number.isFinite(event.maxAssets ?? 200)
                    ? (event.maxAssets ?? 200)
                    : ''
                }
                onChange={(e) =>
                  onChange({
                    ...value,
                    events: events.map((t, i) =>
                      i === index
                        ? { ...t, maxAssets: e.target.valueAsNumber }
                        : t,
                    ),
                  })
                }
              />
            </label>
          </div>
          <ProjectTriggerFilters
            event={event.event}
            value={event}
            otherWorkflows={[]}
            disabled={disabled}
            onChange={(patch) =>
              onChange({
                ...value,
                events: events.map((t, i) =>
                  i === index ? { ...t, ...patch } : t,
                ),
              })
            }
          />
          {canLaunch && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={event.enabled ?? false}
                onChange={(e) =>
                  onChange({
                    ...value,
                    events: events.map((t, i) =>
                      i === index ? { ...t, enabled: e.target.checked } : t,
                    ),
                  })
                }
              />
              Enable {creationEvents[event.event].toLowerCase()}
            </label>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              onChange({
                ...value,
                events: events.filter((_, i) => i !== index),
              })
            }
          >
            Remove event {index + 1}
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(creationEvents) as ProjectTriggerEvent[])
          .filter((event) => !events.some((t) => t.event === event))
          .map((event) => (
            <Button
              key={event}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...value,
                  events: [
                    ...events,
                    {
                      event,
                      enabled: false,
                      windowMinutes: 10,
                      maxAssets: 200,
                    },
                  ],
                })
              }
            >
              Add {creationEvents[event].toLowerCase()}
            </Button>
          ))}
      </div>
    </section>
  );
}
