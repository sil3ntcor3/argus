import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  getVulnerabilitiesControllerGetVulnerabilityTimelineQueryKey,
  type VulnerabilityTimelineEventDto,
  useVulnerabilitiesControllerGetVulnerabilityTimeline,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { History } from 'lucide-react';
import { useRef, useState } from 'react';

const date = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const statusLabels = new Map([
  ['new', 'New'],
  ['active', 'Active'],
  ['fixed', 'Fixed'],
  ['resurfaced', 'Resurfaced'],
]);

const eventLabels = new Map([
  ['detected', 'First detected'],
  ['dismissed', 'Dismissed'],
  ['reopened', 'Reopened'],
  ['risk_expired', 'Risk acceptance expired'],
]);

function eventLabel(event: VulnerabilityTimelineEventDto) {
  if (event.type !== 'status_changed')
    return eventLabels.get(event.type) ?? 'Finding updated';
  const from = statusLabels.get(event.fromStatus ?? '');
  const to = statusLabels.get(event.toStatus ?? '');
  return from && to ? `${from} → ${to}` : 'Status changed';
}

type TimelineProps = { id: string; name: string; canOpenRuns: boolean };

/** The sheet mounts the query only when its contents open. */
function TimelineEvents({
  id,
  canOpenRuns,
  onRetry,
}: Omit<TimelineProps, 'name'> & { onRetry: () => void }) {
  const { data, error, isError, isFetchedAfterMount, isFetching, refetch } =
    useVulnerabilitiesControllerGetVulnerabilityTimeline(id, {
      query: {
        queryKey: [
          ...getVulnerabilitiesControllerGetVulnerabilityTimelineQueryKey(id),
          canOpenRuns,
        ],
        gcTime: 0,
        refetchOnMount: 'always',
        retry: false,
      },
    });

  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 403 || status === 404) {
    return <p role="status">Finding timeline unavailable</p>;
  }
  if (isError) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load the finding timeline</p>
        <Button
          variant="outline"
          disabled={isFetching}
          onClick={() => {
            onRetry();
            void refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!data || !isFetchedAfterMount) {
    return <p role="status">Loading finding timeline</p>;
  }
  if (!data.data.length) return <p role="status">No events yet.</p>;

  return (
    <ol aria-label="Lifecycle events" className="divide-y">
      {data.data.map((event) => (
        <li key={event.id} className="space-y-1.5 py-3">
          <p className="font-medium">{eventLabel(event)}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <time dateTime={event.occurredAt}>
              {date.format(new Date(event.occurredAt))}
            </time>
            {canOpenRuns && event.jobHistoryId && (
              <Link
                to="/jobs/runs/$id"
                params={{ id: event.jobHistoryId }}
                aria-label={`View run for ${eventLabel(event)}, ${date.format(new Date(event.occurredAt))}, ${event.jobHistoryId.slice(0, 6)}`}
                className="text-primary underline-offset-4 hover:underline focus-visible:underline"
              >
                View run
              </Link>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Opens the finding's history without leaving the detail page. */
export function FindingTimeline({ id, name, canOpenRuns }: TimelineProps) {
  const [open, setOpen] = useState(false);
  const results = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="size-4" aria-hidden="true" />
          Timeline
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full [overflow-wrap:anywhere] sm:max-w-lg">
        <SheetHeader className="pr-12">
          <SheetTitle>Finding timeline</SheetTitle>
          <SheetDescription>Recorded events for {name}</SheetDescription>
        </SheetHeader>
        <div
          ref={results}
          role="region"
          aria-label="Finding timeline results"
          tabIndex={0}
          className="min-h-0 overflow-y-auto px-4 pb-4 focus-visible:outline-ring"
        >
          {open && (
            <TimelineEvents
              id={id}
              canOpenRuns={canOpenRuns}
              onRetry={() => results.current?.focus()}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
