import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectsControllerGetFindingStatistics } from '@/services/apis/gen/queries';
import type { FindingsSearch } from './project-finding-filters';

const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;

/** Summary counts cover recorded project scope, independently of list filters. */
export function ProjectFindingSummary({
  projectId,
  onChange,
  canReadReview,
}: {
  projectId: string;
  canReadReview: boolean;
  onChange: (search: FindingsSearch) => void;
}) {
  const query = useProjectsControllerGetFindingStatistics(projectId, {
    query: { retry: false },
  });
  if (query.isError)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="status">Unable to load project finding counts</p>
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry counts
        </Button>
      </div>
    );
  if (!query.data)
    return (
      <Skeleton
        aria-label="Loading project finding counts"
        role="status"
        className="h-28 rounded-xl"
      />
    );
  const data = query.data;
  return (
    <section aria-label="Project finding summary" className="space-y-3">
      <h2 className="text-sm font-medium">Open findings by severity</h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {severities.map((severity) => (
          <div key={severity} className="min-w-0 rounded-lg border bg-card p-3">
            <dt className="text-sm capitalize text-muted-foreground">
              {severity}
            </dt>
            <dd>
              <button
                className="text-xl font-semibold tabular-nums underline-offset-4 hover:underline"
                aria-label={`Show ${severity} open findings`}
                onClick={() =>
                  onChange({ page: 1, status: 'open', severity: [severity] })
                }
              >
                {data.data.find((row) => row.severity === severity)?.count ?? 0}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <h2 className="text-sm font-medium">Detection lifecycle</h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {(['new', 'active', 'resurfaced', 'fixed'] as const).map((status) => (
          <div key={status} className="rounded-lg border bg-card p-3">
            <dt className="text-sm capitalize text-muted-foreground">
              {status}
            </dt>
            <dd>
              <button
                className="text-xl font-semibold tabular-nums underline-offset-4 hover:underline"
                aria-label={`Show ${status} findings`}
                onClick={() => onChange({ page: 1, status })}
              >
                {data.byDetectionStatus[status]}
              </button>
            </dd>
          </div>
        ))}
        <div className="rounded-lg border bg-card p-3">
          <dt className="text-sm text-muted-foreground">Overdue</dt>
          <dd>
            <button
              className="text-xl font-semibold text-destructive tabular-nums underline-offset-4 hover:underline"
              aria-label="Show overdue findings"
              onClick={() =>
                onChange({ page: 1, status: 'open', overdue: true })
              }
            >
              {data.overdue}
            </button>
          </dd>
        </div>
      </dl>
      {canReadReview && data.pendingReview !== null && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({ page: 1, status: 'pending_review' })}
        >
          Pending review · {data.pendingReview}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {data.newLast7Days} new open findings in 7 days ·{' '}
        {data.resurfacedLast30Days} resurfaced and {data.fixedLast30Days} fixed
        in 30 days
      </p>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Mean time to remediation · last 90 days
        </summary>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {data.mttr.map((row) => (
            <div key={row.severity}>
              <dt className="text-xs capitalize text-muted-foreground">
                {row.severity}
              </dt>
              <dd className="text-sm tabular-nums">
                {row.days === null
                  ? 'No fixes yet'
                  : `${row.days.toFixed(1)} days (${row.count} fixes)`}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
