import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SeverityBadge } from '@/components/ui/severity-badge';
import { useProjectsControllerGetFindings } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { type ReactNode, useId } from 'react';
import { provenanceLabels } from './project-finding-facets';
import { ProjectFindingTimeline } from './project-finding-timeline';

const PREVIEW_LIMIT = 15;

export function ProjectOverviewFindings({
  projectId,
  openCount,
  canOpenRuns,
}: {
  projectId: string;
  openCount: number;
  canOpenRuns: boolean;
}) {
  const headingId = useId();
  const { data, error, isError, isFetching, refetch } =
    useProjectsControllerGetFindings(
      projectId,
      { page: 1, limit: PREVIEW_LIMIT, status: 'open' },
      { query: { enabled: openCount > 0, retry: false } },
    );
  const status = isAxiosError(error) ? error.response?.status : undefined;

  let content: ReactNode;
  if (openCount === 0) {
    content = <p className="text-sm text-muted-foreground">No open findings</p>;
  } else if (status === 403 || status === 404) {
    content = <p role="status">Open findings unavailable</p>;
  } else if (isError) {
    content = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load open findings</p>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );
  } else if (!data) {
    content = <p role="status">Loading open findings</p>;
  } else if (data.data.length === 0) {
    content = <p className="text-sm text-muted-foreground">No open findings</p>;
  } else {
    content = (
      <ul
        aria-label="Open project findings preview"
        tabIndex={0}
        className="max-h-[30rem] divide-y overflow-y-auto rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      >
        {data.data.map((finding) => {
          const provenance =
            finding.provenance === 'recurring'
              ? `Recurring ×${finding.timesSeen}`
              : provenanceLabels[finding.provenance];
          return (
            <li key={finding.id}>
              <ProjectFindingTimeline
                projectId={projectId}
                finding={finding}
                canOpenRuns={canOpenRuns}
                trigger={
                  <button
                    type="button"
                    aria-label={`View timeline for ${finding.name} on ${finding.assetValue}, ${finding.severity}, ${provenance}`}
                    className="flex w-full flex-wrap items-center gap-2 rounded-sm p-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <SeverityBadge severity={finding.severity} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {finding.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {finding.assetValue}
                      </span>
                    </span>
                    <Badge variant="outline">{provenance}</Badge>
                  </button>
                }
              />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          To fix
        </h2>
        <Link
          to="/projects/$id/findings"
          params={{ id: projectId }}
          search={{ status: 'open' }}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:underline"
        >
          See all open findings
        </Link>
      </div>
      {content}
    </section>
  );
}
