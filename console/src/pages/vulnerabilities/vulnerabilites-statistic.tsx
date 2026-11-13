import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { useVulnerabilitiesControllerGetVulnerabilitiesStatistics } from '@/services/apis/gen/queries';
import { useNavigate } from '@tanstack/react-router';

const severities = [
  { key: 'critical', label: 'Critical', color: 'text-red-500' },
  { key: 'high', label: 'High', color: 'text-orange-500' },
  { key: 'medium', label: 'Medium', color: 'text-yellow-600' },
  { key: 'low', label: 'Low', color: 'text-blue-500' },
  { key: 'info', label: 'Info', color: 'text-foreground' },
] as const;

const grid = 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5';

/** Shows severity counts for the same workspace or target as the list. */
export default function VulnerabilitiesStatistic({
  targetId,
}: {
  targetId?: string;
}) {
  const { selectedWorkspace } = useWorkspaceSelector();
  const navigate = useNavigate();
  const { data, isLoading, isError, isFetching, errorUpdatedAt, refetch } =
    useVulnerabilitiesControllerGetVulnerabilitiesStatistics(
      targetId ? { targetIds: [targetId] } : {},
      {
        query: {
          enabled: Boolean(selectedWorkspace),
          refetchInterval: ({ state }) =>
            state.data || !state.errorUpdatedAt ? 5000 : false,
          retry: false,
        },
      },
    );

  if (!data && (isError || errorUpdatedAt > 0)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="text-sm">
          Unable to load severity counts
        </p>
        <Button
          size="sm"
          variant="outline"
          aria-label="Retry severity counts"
          aria-disabled={isFetching}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (!isFetching) void refetch();
          }}
        >
          {isFetching ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={grid} role="status" aria-label="Loading severity counts">
        {severities.map(({ key }) => (
          <Skeleton className="h-20" key={key} />
        ))}
      </div>
    );
  }

  const counts = new Map(
    data?.data.map(({ severity, count }) => [severity, count]),
  );

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">Open findings by severity</h2>
      <dl className={grid} aria-label="Finding severity counts">
        {severities.map(({ key, label, color }) => (
          <div key={key} className="min-w-0 rounded-lg border bg-card p-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className={`text-xl font-semibold tabular-nums ${color}`}>
              {counts.get(key) ?? 0}
            </dd>
          </div>
        ))}
      </dl>
      {data?.byDetectionStatus && <>
        <h2 className="pt-2 text-sm font-medium">Detection lifecycle</h2>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Finding lifecycle counts">
          {(['new', 'active', 'resurfaced', 'fixed'] as const).map(status => <div key={status} className="rounded-lg border bg-card p-3">
            <dt className="text-sm capitalize text-muted-foreground">{status}</dt>
            <dd><button className="text-xl font-semibold tabular-nums underline-offset-4 hover:underline" aria-label={`Show ${status} findings`}
              onClick={() => navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, status, overdue: undefined, page: 1 })) as never })}>
              {data.byDetectionStatus[status]}</button></dd>
          </div>)}
          <div className="rounded-lg border bg-card p-3"><dt className="text-sm text-muted-foreground">Overdue</dt><dd>
            <button className="text-xl font-semibold text-destructive tabular-nums underline-offset-4 hover:underline" aria-label="Show overdue findings"
              onClick={() => navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, status: 'open', overdue: 'true', page: 1 })) as never })}>{data.overdue}</button>
          </dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">{data.newLast7Days} new open findings in 7 days · {data.resurfacedLast30Days} resurfaced and {data.fixedLast30Days} fixed in 30 days</p>
        <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Mean time to remediation · last 90 days</summary>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">{data.mttr.map(row => <div key={row.severity}>
            <dt className="text-xs capitalize text-muted-foreground">{row.severity}</dt>
            <dd className="text-sm tabular-nums">{row.days === null ? 'No fixes yet' : `${row.days.toFixed(1)} days (${row.count} fixes)`}</dd>
          </div>)}</dl>
        </details>
      </>}
    </div>
  );
}
