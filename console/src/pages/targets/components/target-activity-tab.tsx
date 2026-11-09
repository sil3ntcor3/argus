import AccessDenied from '@/components/common/access-denied';
import { Button } from '@/components/ui/button';
import JobStatusBadge from '@/components/ui/job-status';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type TargetRunDto,
  useTargetsControllerGetTargetRunsInfinite,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useEffect, useRef } from 'react';

const runDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function TargetRunRow({ run }: { run: TargetRunDto }) {
  const name = run.workflowName.trim() || 'Workflow run';
  const started = runDate.format(new Date(run.createdAt));
  const trigger = run.jobRunType === 'scheduled' ? 'Scheduled' : 'Manual';
  return (
    <li className="space-y-1 p-3 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <Link
          to="/jobs/runs/$id"
          params={{ id: run.id }}
          aria-label={`${name}, ${trigger}, ${started}, ${run.id.slice(0, 8)}`}
          className="min-w-0 rounded-sm text-sm font-medium break-words text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {name}
        </Link>
        <JobStatusBadge status={run.status} />
      </div>
      <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{trigger}</span>
        <time dateTime={run.createdAt}>{started}</time>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {run.jobsDone} done · {run.jobsFailed} failed · {run.jobsRunning}{' '}
        running · {run.jobsTotal} total
      </p>
    </li>
  );
}

export function TargetActivityTab({
  targetId,
  onAccessDenied,
}: {
  targetId: string;
  onAccessDenied: () => Promise<unknown>;
}) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const list = useRef<HTMLUListElement>(null);
  const keyboardLoad = useRef<{ button: HTMLButtonElement; index: number }>(
    null,
  );
  const {
    data,
    error,
    isError,
    errorUpdatedAt,
    dataUpdatedAt,
    isFetchedAfterMount,
    isFetching,
    isFetchNextPageError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useTargetsControllerGetTargetRunsInfinite(
    targetId,
    { limit: 10 },
    {
      query: {
        enabled: Boolean(selectedWorkspaceId),
        queryKey: ['target-runs', selectedWorkspaceId, targetId],
        initialPageParam: 1,
        getNextPageParam: (last) =>
          last.hasNextPage ? last.page + 1 : undefined,
        gcTime: 0,
        refetchOnMount: 'always',
        retry: false,
      },
    },
  );

  const status = isAxiosError(error) ? error.response?.status : undefined;
  const denied = status === 401 || status === 403;
  useEffect(() => {
    if (denied && selectedWorkspaceId) void onAccessDenied();
  }, [denied, onAccessDenied, selectedWorkspaceId]);

  const failed =
    !isFetchNextPageError && (isError || errorUpdatedAt > dataUpdatedAt);
  const runs =
    !denied && !failed && isFetchedAfterMount && data
      ? Array.from(
          new Map(
            data.pages.flatMap((page) => page.data.map((run) => [run.id, run])),
          ).values(),
        )
      : undefined;
  const runCount = runs?.length;
  useEffect(() => {
    if (isFetchingNextPage || !keyboardLoad.current) return;
    const { button, index } = keyboardLoad.current;
    keyboardLoad.current = null;
    if (isFetchNextPageError || !runCount) return;
    if (
      document.activeElement === button ||
      document.activeElement === document.body
    ) {
      (list.current?.querySelectorAll('a')[index] ?? list.current)?.focus();
    }
  }, [isFetchNextPageError, isFetchingNextPage, runCount]);

  if (!selectedWorkspaceId) return null;

  return (
    <section aria-label="Target activity" className="space-y-3">
      <h2 className="text-base font-semibold">Runs</h2>
      {denied ? (
        <AccessDenied />
      ) : failed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
          <p role="status" className="text-sm text-muted-foreground">
            Could not load target activity.
          </p>
          <Button
            size="sm"
            variant="outline"
            aria-label="Retry activity"
            aria-disabled={isFetching}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!isFetching) void refetch();
            }}
          >
            {isFetching ? 'Retrying…' : 'Retry activity'}
          </Button>
        </div>
      ) : !runs ? (
        <div role="status" aria-label="Loading target activity">
          <Skeleton className="h-24" />
        </div>
      ) : runs.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          No runs for this target yet.
        </p>
      ) : (
        <>
          <ul
            ref={list}
            tabIndex={-1}
            aria-label="Workflow runs"
            className="divide-y rounded-lg border"
          >
            {runs.map((run) => (
              <TargetRunRow key={run.id} run={run} />
            ))}
          </ul>
          {isFetchNextPageError && (
            <p role="status" className="text-sm text-muted-foreground">
              Could not load more runs.
            </p>
          )}
          {hasNextPage && (
            <Button
              size="sm"
              variant="outline"
              aria-label="Load more runs"
              aria-disabled={isFetching}
              className="aria-disabled:opacity-50"
              onClick={(event) => {
                if (isFetching) return;
                if (event.detail === 0) {
                  keyboardLoad.current = {
                    button: event.currentTarget,
                    index: runs.length,
                  };
                }
                void fetchNextPage();
              }}
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more runs'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
