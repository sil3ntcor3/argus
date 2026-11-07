import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type ProjectViewDto,
  useProjectsControllerGetMany,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import dayjs from 'dayjs';
import { type FormEvent, type ReactNode, useState } from 'react';

const grid = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3';
const countFormat = new Intl.NumberFormat();

type ListParams = { page: number; search: string };
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
function ProjectCard({ project }: { project: ProjectViewDto }) {
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
      {project.description && (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {project.description}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Assets</dt>
          <dd className="font-medium tabular-nums">
            {countFormat.format(project.totalAssets)}
          </dd>
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
    </li>
  );
}

/** Reads the requested page within the selected workspace. */
function WorkspaceProjectList({ page, search, onChange }: ListProps) {
  const [draft, setDraft] = useState(search);
  const { data, error, isError, isPending, isFetching, refetch } =
    useProjectsControllerGetMany({
      page,
      limit: 12,
      sortBy: 'name',
      sortOrder: 'ASC',
      search: search || undefined,
    });
  const beyondLastPage = data && page > Math.max(1, data.pageCount);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChange({ search: draft.trim(), page: 1 });
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
          <ProjectCard key={project.id} project={project} />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-4">
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
              onChange({ search, page: beyondLastPage ? 1 : page - 1 })
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
            onClick={() => onChange({ search, page: page + 1 })}
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
  let content: ReactNode;
  if (!selectedWorkspaceId) {
    content = <p role="status">Select a workspace to view projects.</p>;
  } else if (permission.isLoading) {
    content = <ProjectListLoading />;
  } else if (permission.error) {
    content = <p role="status">Unable to load project access</p>;
  } else if (
    !permission.hasPermission('project.read') &&
    !permission.hasPermission('group.read')
  ) {
    content = <AccessDenied />;
  } else {
    content = (
      <WorkspaceProjectList
        key={`${selectedWorkspaceId}:${props.search}`}
        {...props}
      />
    );
  }
  return (
    <Page
      title="Projects"
      description="Organize assets and see what each scan found"
    >
      {content}
    </Page>
  );
}
