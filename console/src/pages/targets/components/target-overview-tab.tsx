import AccessDenied from '@/components/common/access-denied';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { useTargetsControllerGetTargetOverview } from '@/services/apis/gen/queries';
import { isAxiosError } from 'axios';
import { useEffect } from 'react';
import { TargetExposurePanel } from './target-exposure-panel';

const formatCount = new Intl.NumberFormat();
const grid = 'grid gap-3 sm:grid-cols-3';

/** Displays the asset and service surface of one target. */
export function TargetOverviewTab({
  targetId,
  onAccessDenied,
}: {
  targetId: string;
  onAccessDenied: () => Promise<unknown>;
}) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const overview = useTargetsControllerGetTargetOverview(targetId, {
    query: {
      enabled: Boolean(selectedWorkspaceId),
      queryKey: ['target-overview', selectedWorkspaceId, targetId],
      refetchOnMount: 'always',
      retry: false,
    },
  });

  const {
    error,
    isError,
    errorUpdatedAt,
    dataUpdatedAt,
    isFetchedAfterMount,
    isFetching,
    refetch,
  } = overview;
  const status = isAxiosError(error) ? error.response?.status : undefined;
  const denied = status === 401 || status === 403;
  useEffect(() => {
    if (denied && selectedWorkspaceId) void onAccessDenied();
  }, [denied, onAccessDenied, selectedWorkspaceId]);

  if (!selectedWorkspaceId) return null;

  const failed = isError || errorUpdatedAt > dataUpdatedAt;
  const data = !failed && isFetchedAfterMount ? overview.data : undefined;

  return (
    <section aria-label="Target overview" className="space-y-4">
      {denied ? (
        <AccessDenied />
      ) : failed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
          <p role="status" className="text-sm text-muted-foreground">
            Could not load target overview.
          </p>
          <Button
            variant="outline"
            size="sm"
            aria-label="Retry overview"
            aria-disabled={isFetching}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!isFetching) void refetch();
            }}
          >
            {isFetching ? 'Retrying…' : 'Retry overview'}
          </Button>
        </div>
      ) : data ? (
        <dl className={grid}>
          {[
            {
              label: 'Enabled assets',
              total: data.totalAssets,
              recent: data.newAssets,
            },
            {
              label: 'Discovered services',
              total: data.totalServices,
              recent: data.newServices,
            },
            { label: 'Open ports', total: data.openPorts },
          ].map(({ label, total, recent }) => (
            <Card key={label} className="min-w-0 gap-2 p-4">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="flex flex-col gap-1">
                <span className="text-2xl font-semibold tabular-nums">
                  {formatCount.format(total)}
                </span>
                {recent !== undefined ? (
                  <span className="text-sm text-muted-foreground">
                    {formatCount.format(recent)} new in the last 7 days
                  </span>
                ) : null}
              </dd>
            </Card>
          ))}
        </dl>
      ) : (
        <div
          className={grid}
          role="status"
          aria-label="Loading target overview"
        >
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      )}
      {data?.exposure && <TargetExposurePanel exposure={data.exposure} />}
    </section>
  );
}
