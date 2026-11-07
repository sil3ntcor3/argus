import { Badge } from '@/components/ui/badge';
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
  type ProjectFindingDto,
  type ProjectFindingTimelineRunDto,
  type ProjectFindingTimelineRunDtoSighting,
  useProjectsControllerGetFindingTimeline,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';

const sightings = {
  seen: 'Reported',
  missed: 'Scanned, not reported',
  unknown: 'Scanned, sighting not recorded',
} satisfies Record<ProjectFindingTimelineRunDtoSighting, string>;

const date = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

type TimelineProps = {
  projectId: string;
  finding: Pick<ProjectFindingDto, 'id' | 'name' | 'assetValue'>;
  canOpenRuns: boolean;
};

/** Mounted by the sheet only while the timeline is open. */
function TimelineRuns({ projectId, finding, canOpenRuns }: TimelineProps) {
  const { data, error, isError, isFetching, refetch } =
    useProjectsControllerGetFindingTimeline(projectId, finding.id, {
      query: { retry: false },
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
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  let content = <p aria-hidden="true">Loading finding timeline</p>;
  if (data) {
    content = data.runs.length ? (
      <TimelineRunList runs={data.runs} canOpenRuns={canOpenRuns} />
    ) : (
      <p>No run sightings available</p>
    );
  }

  return (
    <>
      <p role="status" className="sr-only">
        {data
          ? `${data.runs.length} run sightings available`
          : 'Loading finding timeline'}
      </p>
      {content}
    </>
  );
}

function TimelineRunList({
  runs,
  canOpenRuns,
}: {
  runs: ProjectFindingTimelineRunDto[];
  canOpenRuns: boolean;
}) {
  return (
    <ol aria-label="Run sightings" className="divide-y">
      {runs.map((run) => {
        const when = date.format(new Date(run.createdAt));
        const label = run.workflowName.trim() || 'Workflow run';
        return (
          <li key={run.id} className="space-y-2 py-3">
            {canOpenRuns ? (
              <Link
                to="/jobs/runs/$id"
                params={{ id: run.id }}
                aria-label={`${label}, ${when}, run ${run.id.slice(0, 6)}`}
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline"
              >
                {label}
              </Link>
            ) : (
              <p className="font-medium">{label}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <time dateTime={run.createdAt}>{when}</time>
              <Badge variant="outline">{sightings[run.sighting]}</Badge>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Keeps historical project sightings readable without requiring job detail access. */
export function ProjectFindingTimeline(props: TimelineProps) {
  const { finding } = props;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`View timeline for ${finding.name} on ${finding.assetValue}`}
        >
          View timeline
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full [overflow-wrap:anywhere] sm:max-w-lg">
        <SheetHeader className="pr-12">
          <SheetTitle>{finding.name}</SheetTitle>
          <SheetDescription>
            Project run sightings for {finding.assetValue}
          </SheetDescription>
        </SheetHeader>
        <div
          role="region"
          aria-label="Finding timeline results"
          tabIndex={0}
          className="min-h-0 overflow-y-auto px-4 pb-4 focus-visible:outline-ring"
        >
          <TimelineRuns {...props} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
