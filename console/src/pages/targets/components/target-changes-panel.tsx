import AccessDenied from '@/components/common/access-denied';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  TargetChangeKind,
  useTargetsControllerGetTargetChanges,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useEffect, useRef, useState } from 'react';

const filters = [
  { label: 'All', kind: undefined },
  { label: 'Assets', kind: TargetChangeKind.asset },
  { label: 'Services', kind: TargetChangeKind.service },
  { label: 'Findings', kind: TargetChangeKind.vulnerability },
] as const;
const changeLabels: Record<TargetChangeKind, string> = {
  [TargetChangeKind.asset]: 'Asset discovered',
  [TargetChangeKind.service]: 'Service discovered',
  [TargetChangeKind.vulnerability]: 'Finding discovered',
};
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
type PanelProps = {
  targetId: string;
  canReadFindings: boolean;
  onAccessDenied: () => Promise<unknown>;
};

/** Resets the feed when the selected workspace or finding access changes. */
export function TargetChangesPanel(props: PanelProps) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  return selectedWorkspaceId ? (
    <TargetChangesList
      key={`${selectedWorkspaceId}:${props.canReadFindings}`}
      workspaceId={selectedWorkspaceId}
      {...props}
    />
  ) : null;
}

/** Shows one server-paginated page of discoveries for the selected target. */
function TargetChangesList({
  workspaceId,
  targetId,
  canReadFindings,
  onAccessDenied,
}: PanelProps & { workspaceId: string }) {
  const [view, setView] = useState<{ page: number; kind?: TargetChangeKind }>({
    page: 1,
  });
  const { page, kind } = view;
  const visibleFilters = filters.filter(
    ({ kind }) => canReadFindings || kind !== TargetChangeKind.vulnerability,
  );
  const title = useRef<HTMLHeadingElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const changes = useTargetsControllerGetTargetChanges(
    targetId,
    { page, limit: 10, kind },
    {
      query: {
        queryKey: [
          'target-changes',
          workspaceId,
          targetId,
          canReadFindings,
          page,
          kind,
        ],
        gcTime: 0,
        refetchOnMount: 'always',
        retry: false,
      },
    },
  );
  const status = isAxiosError(changes.error)
    ? changes.error.response?.status
    : undefined;
  const denied = status === 401 || status === 403;
  useEffect(() => {
    if (denied) void onAccessDenied();
  }, [denied, onAccessDenied]);

  const failed =
    changes.isError || changes.errorUpdatedAt > changes.dataUpdatedAt;
  const data =
    !failed && changes.isFetchedAfterMount ? changes.data : undefined;
  const rows =
    data?.data.filter(
      ({ kind }) => canReadFindings || kind !== TargetChangeKind.vulnerability,
    ) ?? [];
  useEffect(() => {
    if (changes.isFetching || !retryButton.current) return;
    const button = retryButton.current;
    retryButton.current = null;
    if (
      data &&
      (document.activeElement === button ||
        document.activeElement === document.body)
    ) {
      title.current?.focus();
    }
  }, [changes.isFetching, data]);

  return (
    <section aria-label="Target changes" className="min-w-0 space-y-3">
      <h2 ref={title} tabIndex={-1} className="text-base font-semibold">
        Changes
      </h2>
      {denied ? (
        <AccessDenied />
      ) : (
        <>
          <div
            role="group"
            aria-label="Discovery type"
            className="flex flex-wrap gap-2"
          >
            {visibleFilters.map((filter) => (
              <Button
                key={filter.label}
                size="sm"
                variant={kind === filter.kind ? 'secondary' : 'outline'}
                aria-pressed={kind === filter.kind}
                onClick={() => setView({ kind: filter.kind, page: 1 })}
              >
                {filter.label}
              </Button>
            ))}
          </div>
          {failed ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
              <p role="status" className="text-sm text-muted-foreground">
                Could not load discoveries.
              </p>
              <Button
                size="sm"
                variant="outline"
                aria-disabled={changes.isFetching}
                className="aria-disabled:opacity-50"
                onClick={(event) => {
                  if (changes.isFetching) return;
                  if (event.detail === 0)
                    retryButton.current = event.currentTarget;
                  void changes.refetch();
                }}
              >
                Retry discoveries
              </Button>
            </div>
          ) : !data ? (
            <div role="status" aria-label="Loading discoveries">
              <Skeleton className="h-24" />
            </div>
          ) : rows.length === 0 ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">
              No discoveries on this page.
            </p>
          ) : (
            <ul
              aria-label="Discovery changes"
              className="divide-y rounded-lg border"
            >
              {rows.map((change) => (
                <li
                  key={`${change.kind}-${change.id}`}
                  className="space-y-1 p-3 sm:px-4"
                >
                  {change.kind === TargetChangeKind.vulnerability ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to="/vulnerabilities/$id"
                        params={{ id: change.id }}
                        className="min-w-0 rounded-sm text-sm font-medium break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {change.label}
                        {change.assetValue && (
                          <span className="sr-only">
                            {' '}
                            on {change.assetValue}
                          </span>
                        )}
                      </Link>
                      {change.severity && (
                        <Badge variant="outline" className="capitalize">
                          {change.severity}
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm font-medium break-words">
                      {change.label}
                    </p>
                  )}
                  {change.assetValue && (
                    <p className="text-xs break-words text-muted-foreground">
                      Asset {change.assetValue}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span>{changeLabels[change.kind]}</span>
                    <time dateTime={change.at}>
                      {dateFormat.format(new Date(change.at))}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <nav
            aria-label="Discovery pages"
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              size="sm"
              variant="outline"
              aria-disabled={page === 1}
              className="aria-disabled:opacity-50"
              onClick={() => {
                if (page > 1) setView({ kind, page: page - 1 });
              }}
            >
              Previous page
            </Button>
            <span
              role="status"
              className="text-sm tabular-nums text-muted-foreground"
            >
              <span>Page {page}</span>
              {data && (
                <span className="sr-only">
                  , {rows.length} discoveries shown
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              aria-disabled={!data?.hasNextPage || changes.isFetching}
              className="aria-disabled:opacity-50"
              onClick={() => {
                if (data?.hasNextPage && !changes.isFetching)
                  setView({ kind, page: page + 1 });
              }}
            >
              Next page
            </Button>
          </nav>
        </>
      )}
    </section>
  );
}
