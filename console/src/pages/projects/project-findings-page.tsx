import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type ProjectFindingDto,
  ProjectsControllerGetFindingsProvenance,
  useProjectsControllerGetFindings,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import type { ReactNode } from 'react';
import { ProjectFindingTimeline } from './project-finding-timeline';

const provenances = Object.values(ProjectsControllerGetFindingsProvenance);
const provenanceLabels = {
  new: 'New',
  recurring: 'Recurring',
  not_seen: 'Not seen again',
} satisfies Record<ProjectsControllerGetFindingsProvenance, string>;
const projectIdPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
type FindingsSearch = {
  page: number;
  provenance?: ProjectsControllerGetFindingsProvenance;
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
  provenance,
  onChange,
  canOpen,
  canOpenRuns,
}: FindingsProps & { canOpen: boolean; canOpenRuns: boolean }) {
  const { data, error, isError, isPending, isFetching, refetch } =
    useProjectsControllerGetFindings(
      projectId,
      { page, limit: 20, provenance },
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
      <label className="flex w-fit items-center gap-2 text-sm">
        Provenance
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={provenance ?? ''}
          onChange={({ target }) =>
            onChange({
              page: 1,
              provenance: provenances.find((value) => value === target.value),
            })
          }
        >
          <option value="">All open findings</option>
          {provenances.map((value) => (
            <option key={value} value={value}>
              {provenanceLabels[value]}
            </option>
          ))}
        </select>
      </label>
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
                provenance,
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
            if (data?.hasNextPage) onChange({ provenance, page: page + 1 });
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
  else if (!projectIdPattern.test(props.projectId))
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
