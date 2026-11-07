import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type ProjectFindingDto,
  useProjectsControllerGetFindings,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { type ReactNode, useRef } from 'react';
import { ProjectFindingSearch } from './project-finding-search';
import { projectRouteId } from './project-route-id';
import { ProjectWorkflowFilter } from './project-workflow-filter';
import { ProjectFindingTimeline } from './project-finding-timeline';
import {
  type FindingFacets,
  ProjectFindingFacets,
  provenanceLabels,
} from './project-finding-facets';

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
type FindingsSearch = FindingFacets & {
  page: number;
  query?: string;
  run?: string;
  workflow?: string;
};

type FindingsProps = FindingsSearch & {
  projectId: string;
  onChange: (search: FindingsSearch) => void;
};

function FindingCard({
  projectId,
  finding,
  canOpen,
  canOpenRuns,
}: {
  projectId: string;
  finding: ProjectFindingDto;
  canOpen: boolean;
  canOpenRuns: boolean;
}) {
  const provenance =
    finding.provenance === 'recurring'
      ? `Recurring ×${finding.timesSeen}`
      : provenanceLabels[finding.provenance];
  return (
    <li className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">
          {canOpen ? (
            <Link
              to="/vulnerabilities/$id"
              params={{ id: finding.id }}
              aria-label={`${finding.name} on ${finding.assetValue}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:underline"
            >
              {finding.name}
            </Link>
          ) : (
            finding.name
          )}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="capitalize">
            {finding.severity}
          </Badge>
          <Badge variant="outline">{provenance}</Badge>
          {finding.status === 'dismissed' && (
            <Badge variant="outline">Dismissed</Badge>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {finding.assetValue}
        {finding.toolName && ` · ${finding.toolName}`}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>
          First seen{' '}
          <time dateTime={finding.firstSeen.at}>
            {date.format(new Date(finding.firstSeen.at))}
          </time>
        </span>
        <span>
          Last seen{' '}
          <time dateTime={finding.lastSeen.at}>
            {date.format(new Date(finding.lastSeen.at))}
          </time>
        </span>
      </div>
      <ProjectFindingTimeline
        projectId={projectId}
        finding={finding}
        canOpenRuns={canOpenRuns}
      />
    </li>
  );
}

function FindingList({
  projectId,
  page,
  onChange,
  canOpen,
  canOpenRuns,
  query,
  run,
  workflow,
  provenance,
  severity,
  status: findingStatus,
}: FindingsProps & { canOpen: boolean; canOpenRuns: boolean }) {
  const searchInput = useRef<HTMLInputElement>(null);
  const facets = { provenance, severity, status: findingStatus };
  const filters = { ...facets, query, run, workflow };
  const { data, error, isError, isPending, isFetching, refetch } =
    useProjectsControllerGetFindings(
      projectId,
      {
        page,
        limit: 20,
        search: query,
        jobHistoryId: run,
        projectWorkflowId: workflow,
        ...facets,
      },
      { query: { retry: false } },
    );
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 403) return <AccessDenied />;
  if (status === 404) return <p role="status">Project not found</p>;

  let results: ReactNode;
  if (isError) {
    results = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load project findings</p>
        <Button
          variant="outline"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );
  } else if (isPending || !data) {
    results = (
      <Skeleton
        role="status"
        aria-label="Loading project findings"
        className="h-32 rounded-xl"
      />
    );
  } else if (!data.data.length) {
    results = (
      <p role="status">
        {page > 1 ? 'No findings on this page' : 'No findings found'}
      </p>
    );
  } else {
    results = (
      <ol aria-label="Project findings" className="space-y-2">
        {data.data.map((finding) => (
          <FindingCard
            key={finding.id}
            projectId={projectId}
            finding={finding}
            canOpen={canOpen}
            canOpenRuns={canOpenRuns}
          />
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-4">
      {run && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Run {run.slice(0, 8)}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              searchInput.current?.focus();
              onChange({ ...filters, run: undefined, page: 1 });
            }}
          >
            Clear run filter
          </Button>
          <p className="text-sm text-muted-foreground">
            Provenance reflects current project scan history.
          </p>
        </div>
      )}
      <ProjectFindingSearch
        inputRef={searchInput}
        term={query}
        onChange={(next) => onChange({ ...filters, query: next, page: 1 })}
      />
      <ProjectWorkflowFilter
        projectId={projectId}
        workflow={workflow}
        onChange={(next) => onChange({ ...filters, page: 1, workflow: next })}
      />
      <ProjectFindingFacets
        {...facets}
        severityCounts={data?.severityCounts}
        provenanceCounts={data?.provenanceCounts}
        onChange={(next) => onChange({ ...filters, ...next, page: 1 })}
      />
      {results}
      <nav
        aria-label="Project finding pages"
        className="flex flex-wrap items-center gap-3"
      >
        <Button
          variant="outline"
          aria-disabled={page <= 1}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (page > 1)
              onChange({
                ...filters,
                page: page > (data?.pageCount ?? page) ? 1 : page - 1,
              });
          }}
        >
          Previous
        </Button>
        <span aria-live="polite">{data ? `Page ${page}` : ''}</span>
        <Button
          variant="outline"
          aria-disabled={!data?.hasNextPage}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (data?.hasNextPage) onChange({ ...filters, page: page + 1 });
          }}
        >
          Next
        </Button>
      </nav>
    </div>
  );
}

/** Loads attributed project findings only when the workspace allows access. */
export function ProjectFindingsPage(props: FindingsProps) {
  const { state } = useWorkspaceState();
  const permission = usePermission();
  const canRead =
    permission.hasPermission('project.read') ||
    permission.hasPermission('group.read');

  let content: ReactNode;
  if (!state.selectedWorkspaceId)
    content = <p role="status">Select a workspace</p>;
  else if (permission.isLoading)
    content = <p role="status">Loading project access</p>;
  else if (permission.error)
    content = <p role="status">Unable to load project access</p>;
  else if (!canRead) content = <AccessDenied />;
  else if (!projectRouteId.safeParse(props.projectId).success)
    content = <p role="status">Project not found</p>;
  else
    content = (
      <div className="space-y-4">
        <Link
          to="/projects/$id"
          params={{ id: props.projectId }}
          className="text-sm text-primary hover:underline"
        >
          Back to project overview
        </Link>
        <FindingList
          {...props}
          canOpen={permission.hasPermission('vulnerability.read')}
          canOpenRuns={permission.hasPermission('job.read')}
        />
      </div>
    );

  return (
    <Page title="Project findings" className="[overflow-wrap:anywhere]">
      {content}
    </Page>
  );
}
