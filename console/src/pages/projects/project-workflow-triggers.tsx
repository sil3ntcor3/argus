import { useRef, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCronLabel } from '@/lib/cron-schedule';
import type {
  ProjectTriggerDto,
  ProjectTriggerEvent,
} from '@/services/apis/gen/queries';
import type { UseQueryResult } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

export type TriggerQuery = Pick<
  UseQueryResult<ProjectTriggerDto[], unknown>,
  'data' | 'error' | 'isPending' | 'isError' | 'isFetching' | 'refetch'
>;

const eventLabels: Record<ProjectTriggerEvent, string> = {
  'project.assets.added': 'When assets are added',
  'project.run.completed': 'After a project workflow finishes',
  'vulnerability.detected': 'When a vulnerability is found',
};
const firedDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Keeps unsupported cron expressions visible and describes recognized events. */
export function triggerLabel(trigger: ProjectTriggerDto) {
  if (trigger.type === 'cron') {
    const cron = trigger.cron ?? '';
    return `${(cron.trim().split(/\s+/)[3] === '*' && formatCronLabel(cron, 'UTC')) || cron} UTC`;
  }
  return (trigger.event && eventLabels[trigger.event]) || 'Event trigger';
}

/** Shows saved trigger state without changing the legacy binding schedule. */
export function ProjectWorkflowTriggers({
  bindingId,
  workflowName,
  query,
  actions,
}: {
  bindingId: string;
  workflowName: string;
  query: TriggerQuery;
  actions?: (
    trigger: ProjectTriggerDto,
    focusAfterRemove: () => void,
  ) => ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const status = isAxiosError(query.error)
    ? query.error.response?.status
    : undefined;
  const inaccessible = status === 401 || status === 403;
  const rows =
    query.data?.filter((row) => row.projectWorkflowId === bindingId) ?? [];
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={`Triggers for ${workflowName}`}
      className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm"
    >
      <h3 className="font-medium">Triggers</h3>
      {query.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">
            {inaccessible
              ? 'Access to workflow triggers was denied'
              : status === 404
                ? 'Project triggers not found'
                : 'Unable to load workflow triggers'}
          </p>
          {!inaccessible && status !== 404 && (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Retry triggers for ${workflowName}`}
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          )}
        </div>
      ) : query.isPending ? (
        <Skeleton
          aria-label="Loading workflow triggers"
          role="status"
          className="h-12"
        />
      ) : rows.length ? (
        <ul className="space-y-2">
          {rows.map((trigger) => (
            <li key={trigger.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span title={trigger.cron ?? undefined}>
                  {triggerLabel(trigger)}
                </span>
                <Badge variant="outline">
                  {trigger.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
              {trigger.type === 'event' &&
                (trigger.config.windowMinutes !== undefined ||
                  trigger.config.maxAssets !== undefined) && (
                  <p className="text-muted-foreground">
                    {[
                      trigger.config.windowMinutes !== undefined
                        ? `Gather ${trigger.config.windowMinutes} min`
                        : undefined,
                      trigger.config.maxAssets !== undefined
                        ? `Up to ${trigger.config.maxAssets} assets`
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              <p className="text-xs text-muted-foreground">
                {trigger.lastFiredAt &&
                Number.isFinite(Date.parse(trigger.lastFiredAt)) ? (
                  <>
                    Last fired{' '}
                    <time dateTime={trigger.lastFiredAt}>
                      {firedDate.format(new Date(trigger.lastFiredAt))}
                    </time>
                  </>
                ) : (
                  'Never fired'
                )}
              </p>
              {actions?.(trigger, () => section.current?.focus())}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No triggers configured</p>
      )}
    </section>
  );
}
