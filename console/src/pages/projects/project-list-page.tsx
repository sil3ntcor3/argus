import { ProjectSummaryFindings, ProjectSummaryTriggers } from './project-summary-context';
import { ProjectArchiveDialog } from './project-archive-dialog';
import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type ProjectListItemDto,
  getProjectsControllerGetManyQueryKey,
  useProjectsControllerGetMany,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import dayjs from 'dayjs';
import { type FormEvent, type ReactNode, useState } from 'react';

const grid = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3';
const countFormat = new Intl.NumberFormat();

type ProjectStatus = 'active' | 'archived' | 'all';
export type ProjectSort = 'name' | 'risk' | 'newest' | 'lastRun' | 'assets';
type ListParams = { page: number; search: string; status?: ProjectStatus; sort?: ProjectSort };
const sorts = {
  name: { label: 'Name', sortBy: 'name', sortOrder: 'ASC' },
  risk: { label: 'Highest risk', sortBy: 'risk', sortOrder: 'DESC' },
  newest: { label: 'Newest', sortBy: 'createdAt', sortOrder: 'DESC' },
  lastRun: { label: 'Last run', sortBy: 'lastRunAt', sortOrder: 'DESC' },
  assets: { label: 'Most assets', sortBy: 'totalAssets', sortOrder: 'DESC' },
} as const;
type ListProps = ListParams & { onChange: (params: ListParams) => void };

/** Keeps the loading state in the same grid as the eventual results. */
function ProjectListLoading() {
  return (
    <div className={grid} role="status" aria-label="Loading projects">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-32 rounded-xl" />
      ))}
    </div>
  );
}

/** Links directly to the canonical detail route using the project's stable ID. */
function ProjectCard({
  project,
  workspaceId,
  canReadFindings,
}: {
  project: ProjectListItemDto;
  canReadFindings: boolean;
  workspaceId?: string;
}) {
  return (
    <li className="min-w-0 rounded-xl border bg-card p-4 text-card-foreground [overflow-wrap:anywhere]">
      <h2 className="text-base font-semibold">
        <Link
          to="/projects/$id"
          params={{ id: project.id }}
          className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {project.name}
        </Link>
      </h2>
      {project.archivedAt && (
        <p className="mt-1 text-sm text-muted-foreground">Archived</p>
      )}
      {workspaceId && (
        <div className="mt-3">
          <ProjectArchiveDialog
            key={`${workspaceId}:${project.id}:${project.archivedAt ?? 'active'}`}
            project={project}
            workspaceId={workspaceId}
          />
        </div>
      )}
      {project.description && (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {project.description}
        </p>
      )}
      <div className="mt-3"><ProjectSummaryFindings project={project} canRead={canReadFindings} /></div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Assets</dt>
          <dd className="font-medium tabular-nums">
            {countFormat.format(project.totalAssets)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Workflows</dt>
          <dd className="font-medium tabular-nums">{countFormat.format(project.workflowCount ?? 0)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last run</dt>
          <dd className="font-medium">
            {project.lastRunAt ? (
              <time dateTime={project.lastRunAt}>
                {dayjs(project.lastRunAt).format('MMM D, YYYY HH:mm')}
              </time>
            ) : (
              'Never'
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-3"><ProjectSummaryTriggers project={project} /></div>
    </li>
  );
}

/** Reads the requested page within the selected workspace. */
function WorkspaceProjectList({
  page,
  search,
  status = 'active',
  sort = 'name',
  onChange,
  workspaceId,
  canReadFindings,
}: ListProps & { workspaceId?: string; canReadFindings: boolean }) {
  const [draft, setDraft] = useState(search);
  const params = { page, status, limit: 12, sortBy: sorts[sort].sortBy, sortOrder: sorts[sort].sortOrder, search: search || undefined };
  const { data, error, isError, isPending, isFetching, refetch } = useProjectsControllerGetMany(params, {
    query: { queryKey: [...getProjectsControllerGetManyQueryKey(params), canReadFindings], retry: false },
  });
  const beyondLastPage = data && page > Math.max(1, data.pageCount);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChange({ search: draft.trim(), status, sort, page: 1 });
  }

  if (isAxiosError(error) && error.response?.status === 403) {
    return <AccessDenied />;
  }

  let results: ReactNode;
  if (isError) {
    results = (
      <div className="flex items-center gap-3">
        <p role="status">Unable to load projects</p>
        <Button
          type="button"
          variant="outline"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );
  } else if (isPending || !data) {
    results = <ProjectListLoading />;
  } else if (data.data.length === 0) {
    results = (
      <p role="status" className="rounded-xl border bg-card p-6 text-center">
        {page > 1
          ? 'No projects on this page'
          : search
            ? 'No matching projects'
            : 'No projects yet'}
      </p>
    );
  } else {
    results = (
      <ul className={grid} aria-label="Project results">
        {data.data.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            workspaceId={workspaceId}
            canReadFindings={canReadFindings}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-4">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Project status
        <select
          aria-label="Project status"
          value={status}
          className="rounded-md border bg-background px-3 py-2"
          onChange={(event) =>
            onChange({
              page: 1,
              search,
              status: event.target.value as ProjectStatus,
              sort,
            })
          }
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
      </label>
      <label className="flex flex-wrap items-center gap-2 text-sm">Sort projects
        <select className="rounded-md border bg-background px-3 py-2" value={sort}
          onChange={event => { const next = Object.keys(sorts).find(key => key === event.target.value) as ProjectSort | undefined;
            if (next) onChange({ page: 1, search, status, sort: next }); }}>
          {(Object.keys(sorts) as ProjectSort[]).filter(key => key !== 'risk' || canReadFindings).map(key => <option key={key} value={key}>{sorts[key].label}</option>)}
        </select>
      </label>
      <form className="flex max-w-md gap-2" onSubmit={submitSearch}>
        <Input
          type="search"
          aria-label="Search projects"
          placeholder="Search projects…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {results}
      {!isError && (page > 1 || (data?.pageCount ?? 0) > 1) && (
        <nav aria-label="Project pages" className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={page <= 1}
            onClick={() =>
              onChange({ search, status, sort, page: beyondLastPage ? 1 : page - 1 })
            }
          >
            {beyondLastPage ? 'First page' : 'Previous'}
          </Button>
          <span className="text-sm" aria-live="polite">
            Page {page}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={page >= (data?.pageCount ?? 0)}
            onClick={() => onChange({ search, status, sort, page: page + 1 })}
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}

/** Loads the project list only after the workspace read permission resolves. */
export function ProjectListPage(props: ListProps) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const permission = usePermission();
  const canReadFindings = permission.hasPermission('vulnerability.read');
  let content: ReactNode;
  let canCreate = false;
  if (!selectedWorkspaceId) {
    content = <p role="status">Select a workspace to view projects.</p>;
  } else if (permission.isLoading || (props.sort === 'risk' && permission.isFetching)) {
    content = <ProjectListLoading />;
  } else if (permission.error) {
    content = <p role="status">Unable to load project access</p>;
  } else if (
    !permission.hasPermission('project.read') &&
    !permission.hasPermission('group.read')
  ) {
    content = <AccessDenied />;
  } else if (props.sort === 'risk' && !canReadFindings) {
    content = <div className="space-y-3"><AccessDenied /><Button variant="outline" onClick={() => props.onChange({ search: props.search, status: props.status, sort: 'name', page: 1 })}>Sort by name</Button></div>;
  } else {
    canCreate =
      permission.hasPermission('project.write') ||
      permission.hasPermission('group.write');
    content = (
      <WorkspaceProjectList
        key={`${selectedWorkspaceId}:${props.search}:${props.status ?? 'active'}`}
        workspaceId={canCreate ? selectedWorkspaceId : undefined}
        canReadFindings={canReadFindings}
        {...props}
      />
    );
  }
  return (
    <Page
      title="Projects"
      description="Organize assets and see what each scan found"
      action={
        canCreate && (
          <Button asChild>
            <Link to="/projects/create">Create project</Link>
          </Button>
        )
      }
    >
      {content}
    </Page>
  );
}
