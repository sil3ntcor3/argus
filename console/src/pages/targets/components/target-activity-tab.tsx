import AccessDenied from '@/components/common/access-denied';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { useTargetsControllerGetTargetRunsInfinite } from '@/services/apis/gen/queries';
import { isAxiosError } from 'axios';
import { useEffect, useId, useRef, useState } from 'react';
import { TargetRunRow } from './target-run-row';

export function TargetActivityTab({
  targetId,
  canReadProjects,
  onAccessDenied,
}: {
  targetId: string;
  canReadProjects: boolean;
  onAccessDenied: () => Promise<unknown>;
}) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const [activeOnly, setActiveOnly] = useState(false);
  const filterId = useId();
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
    { limit: 10, active: activeOnly || undefined },
    {
      query: {
        enabled: Boolean(selectedWorkspaceId),
        queryKey: [
          'target-runs',
          selectedWorkspaceId,
          targetId,
          activeOnly,
          canReadProjects,
        ],
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
      (
        list.current?.children[index]?.querySelector('a') ?? list.current
      )?.focus();
    }
  }, [isFetchNextPageError, isFetchingNextPage, runCount]);

  if (!selectedWorkspaceId) return null;

  return (
    <section aria-label="Target activity" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Runs</h2>
        {!denied && (
          <div className="flex items-center gap-2">
            <Switch
              id={filterId}
              aria-describedby={`${filterId}-description`}
              checked={activeOnly}
              onCheckedChange={setActiveOnly}
            />
            <Label htmlFor={filterId} className="font-normal">
              Active runs only
            </Label>
            <span id={`${filterId}-description`} className="sr-only">
              Show pending or running runs started in the last seven days.
            </span>
          </div>
        )}
      </div>
      <p role="status" aria-label="Run results" className="sr-only">
        {runs &&
          `Showing ${runs.length} ${activeOnly ? 'active ' : ''}${runs.length === 1 ? 'run' : 'runs'}.`}
      </p>
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
          {activeOnly
            ? 'No active runs started in the last seven days.'
            : 'No runs for this target yet.'}
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
              <TargetRunRow
                key={run.id}
                run={run}
                canReadProjects={canReadProjects}
              />
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
