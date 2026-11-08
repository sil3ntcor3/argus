import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { useVulnerabilitiesControllerGetVulnerabilitiesStatistics } from '@/services/apis/gen/queries';

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
    </div>
  );
}
