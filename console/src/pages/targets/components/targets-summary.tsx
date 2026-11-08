import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { useTargetsControllerGetTargetsSummary } from '@/services/apis/gen/queries';
import {
  CalendarClock,
  Crosshair,
  History,
  Radar,
  ShieldAlert,
} from 'lucide-react';

const formatCount = new Intl.NumberFormat();

/** Shows workspace-wide target counts above the independently filtered table. */
export function TargetsSummary() {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const { hasPermission } = usePermission();
  const canReadFindings = hasPermission('vulnerability.read');
  const summary = useTargetsControllerGetTargetsSummary({
    query: {
      enabled: Boolean(selectedWorkspaceId),
      // Target-list refetches also match inactive workspaces.
      queryKey: ['target-summary', selectedWorkspaceId, canReadFindings],
      refetchInterval: ({ state }) =>
        state.data || !state.errorUpdatedAt ? 10_000 : false,
      retry: false,
    },
  });

  if (!selectedWorkspaceId) return null;

  const { isError, isFetching, errorUpdatedAt, dataUpdatedAt, refetch } =
    summary;
  const data = errorUpdatedAt > dataUpdatedAt ? undefined : summary.data;
  const critical = canReadFindings ? data?.withCritical : null;
  const showCritical = critical != null;
  const cards = data
    ? [
        { label: 'Total targets', value: data.total, icon: Crosshair },
        { label: 'Scanning', value: data.scanning, icon: Radar },
        ...(showCritical
          ? [
              {
                label: 'With critical findings',
                value: critical,
                icon: ShieldAlert,
              },
            ]
          : []),
        { label: 'Stale', value: data.stale, icon: History },
        { label: 'Scheduled', value: data.scheduled, icon: CalendarClock },
      ]
    : [];
  const grid =
    'grid grid-cols-2 gap-3 md:grid-cols-3 ' +
    (showCritical ? 'xl:grid-cols-5' : 'xl:grid-cols-4');

  return (
    <section aria-label="Target summary">
      {!data && (isError || errorUpdatedAt > 0) ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
          <p role="status" className="text-sm text-muted-foreground">
            Could not load target summary.
          </p>
          <Button
            variant="outline"
            size="sm"
            aria-label="Retry summary"
            aria-disabled={isFetching}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!isFetching) void refetch();
            }}
          >
            {isFetching ? 'Retrying…' : 'Retry summary'}
          </Button>
        </div>
      ) : data ? (
        <dl className={grid}>
          {cards.map(({ label, value, icon: Icon }) => (
            <Card key={label} className="min-w-0 gap-2 p-4">
              <dt className="flex items-start gap-2 text-sm text-muted-foreground">
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {label}
              </dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {formatCount.format(value)}
              </dd>
            </Card>
          ))}
        </dl>
      ) : (
        <div className={grid} role="status" aria-label="Loading target summary">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      )}
    </section>
  );
}
