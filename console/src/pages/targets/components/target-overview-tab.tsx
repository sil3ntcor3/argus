import AccessDenied from '@/components/common/access-denied';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { useTargetsControllerGetTargetOverview } from '@/services/apis/gen/queries';
import { isAxiosError } from 'axios';
import { useEffect } from 'react';
import { TargetExposurePanel } from './target-exposure-panel';
import { TargetFindingsCard } from './target-findings-card';
import { TargetInsightsPanel } from './target-insights-panel';
import { TargetRunRow } from './target-run-row';

const formatCount = new Intl.NumberFormat();
const formatScanTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const grid = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4';

/** Displays the asset and service surface of one target. */
export function TargetOverviewTab({
  targetId,
  canManageDiscovery,
  canReadJobs,
  canReadFindings,
  onKeyboardNavigate,
  onAccessDenied,
}: {
  targetId: string;
  canManageDiscovery: boolean;
  canReadJobs: boolean;
  canReadFindings: boolean;
  onKeyboardNavigate: (tab: 'assets' | 'settings' | 'vulnerabilities') => void;
  onAccessDenied: () => Promise<unknown>;
}) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const overview = useTargetsControllerGetTargetOverview(targetId, {
    query: {
      enabled: Boolean(selectedWorkspaceId),
      queryKey: [
        'target-overview',
        selectedWorkspaceId,
        targetId,
        canReadFindings,
        canReadJobs,
      ],
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
  const activeRuns = canReadJobs ? data?.activeRuns : null;
  const nextScan =
    typeof data?.nextScanAt === 'string' ? new Date(data.nextScanAt) : null;

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
          <Card className="min-w-0 gap-2 p-4">
            <dt className="text-sm text-muted-foreground">
              Scheduled discovery
            </dt>
            <dd className="text-sm font-medium">
              {nextScan && !Number.isNaN(nextScan.getTime()) ? (
                <time dateTime={nextScan.toISOString()}>
                  {formatScanTime.format(nextScan)}
                </time>
              ) : (
                'No scheduled time available'
              )}
            </dd>
          </Card>
        </dl>
      ) : (
        <div
          className={grid}
          role="status"
          aria-label="Loading target overview"
        >
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      )}
      {canReadJobs && data?.lastRun !== undefined && (
        <section aria-label="Latest run">
          <Card className="gap-2 p-4">
            <h2 className="text-base font-semibold">Latest run</h2>
            {data.lastRun ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Status covers the whole run. Job counts are for this target.
                </p>
                <ul role="list" className="rounded-md border">
                  <TargetRunRow run={data.lastRun} />
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No runs to show.</p>
            )}
          </Card>
        </section>
      )}
      {activeRuns && activeRuns.length > 0 && (
        <section aria-label="Active runs">
          <Card className="gap-2 p-4">
            <h2 className="text-base font-semibold">Active runs</h2>
            <p className="text-xs text-muted-foreground">
              Up to five active runs created in the last seven days. Job counts
              are for this target.
            </p>
            <ul role="list" className="divide-y rounded-md border">
              {activeRuns.map((run) => (
                <TargetRunRow key={run.id} run={run} />
              ))}
            </ul>
          </Card>
        </section>
      )}
      {canReadFindings &&
        data?.openVulnerabilities != null &&
        data.newVulnerabilities != null && (
          <TargetFindingsCard
            targetId={targetId}
            counts={data.openVulnerabilities}
            newCount={data.newVulnerabilities}
            onKeyboardNavigate={() => onKeyboardNavigate('vulnerabilities')}
          />
        )}
      {data?.insights && (
        <TargetInsightsPanel
          insights={data.insights}
          targetId={targetId}
          canManageDiscovery={canManageDiscovery}
          canReadJobs={canReadJobs}
          canReadFindings={canReadFindings}
          onKeyboardNavigate={onKeyboardNavigate}
        />
      )}
      {data?.exposure && <TargetExposurePanel exposure={data.exposure} />}
    </section>
  );
}
