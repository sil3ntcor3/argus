import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Pagination as PaginationNav,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { useSearchControllerSearchAssetsTargets } from '@/services/apis/gen/queries';
import {
  ArrowRight,
  CloudCheck,
  Loader2,
  Search as SearchIcon,
  Target,
} from 'lucide-react';
import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';

interface SearchItem {
  id: string;
  value: string;
}

const categories = [
  { key: 'targets', label: 'Targets', icon: Target },
  { key: 'assets', label: 'Assets', icon: CloudCheck },
] as const;

function SearchResultSection({
  category,
  items,
}: {
  category: (typeof categories)[number];
  items: SearchItem[];
}) {
  const { icon: Icon, key, label } = category;
  return (
    <section className="overflow-hidden rounded-lg border">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 font-medium sm:px-6">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {label}
      </h2>
      <ul className="divide-y">
        {items.map((item) => {
          const destination =
            key === 'targets'
              ? ({
                  to: '/targets/$id/$tab',
                  params: { id: item.id, tab: 'inventory' },
                } as const)
              : ({
                  to: '/assets/services/$id',
                  params: { id: item.id },
                } as const);
          return (
            <li key={item.id}>
              <Link
                {...destination}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted focus-visible:bg-muted sm:px-6"
              >
                <span className="min-w-0 break-all font-medium">
                  {item.value}
                </span>
                <ArrowRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const routeApi = getRouteApi('/_authed/search');

export default function Search() {
  const { query } = routeApi.useSearch();
  const navigate = useNavigate();
  const refocus = useRef(false);
  const focusSearchInput = useCallback((input: HTMLInputElement | null) => {
    if (!input || !refocus.current) return;
    refocus.current = false;
    input.focus();
  }, []);
  const changeQuery = (value: string) => {
    refocus.current = true;
    void navigate({ to: '/search', search: { query: value } });
  };
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();

  return (
    <SearchResults
      key={JSON.stringify([selectedWorkspaceId, query])}
      searchQuery={query}
      hasWorkspace={Boolean(selectedWorkspaceId)}
      inputRef={focusSearchInput}
      onQueryChange={changeQuery}
    />
  );
}

function SearchResults({
  searchQuery,
  hasWorkspace,
  inputRef,
  onQueryChange,
}: {
  searchQuery: string;
  hasWorkspace: boolean;
  inputRef: (input: HTMLInputElement | null) => void;
  onQueryChange: (query: string) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(searchQuery);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('all');
  const { hasPermission, isLoading, error } = usePermission();
  const canSearch =
    hasWorkspace &&
    !error &&
    hasPermission('asset.read') &&
    hasPermission('target.read');
  const enabled = canSearch && Boolean(searchQuery);
  const { data, isFetching, isError, refetch } =
    useSearchControllerSearchAssetsTargets(
      { value: searchQuery, page, isSaveHistory: true },
      { query: { enabled } },
    );
  const results = enabled && !isError ? data : undefined;
  const counts = {
    targets: results?.data.targets.length ?? 0,
    assets: results?.data.assets.length ?? 0,
  };
  const visibleCategories = categories.filter(
    ({ key }) => (tab === 'all' || tab === key) && counts[key] > 0,
  );

  let message = '';
  if (!hasWorkspace) message = 'Choose a workspace to search.';
  else if (error) message = 'Workspace access could not be verified.';
  else if (isLoading) message = 'Checking workspace access…';
  else if (!canSearch)
    message = 'Search requires target and asset read access.';
  else if (!searchQuery)
    message = 'Enter a query to search targets and assets.';
  else if (isError) message = 'Search is unavailable. Try again.';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = draft.trim();
    if (!query || !canSearch) return;
    if (query === searchQuery) {
      if (page === 1) void refetch();
      setPage(1);
      setTab('all');
    } else {
      onQueryChange(query);
    }
  };

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <div className="space-y-3 rounded-lg border p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <SearchIcon className="size-5 text-muted-foreground" aria-hidden />
          Search Results
        </h1>
        <form className="flex items-end gap-2" onSubmit={submit}>
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={inputId}>Search query</Label>
            <Input
              id={inputId}
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Search targets and assets"
            />
          </div>
          <Button type="submit" disabled={!canSearch || !draft.trim()}>
            Search
          </Button>
        </form>
        {results && (
          <p className="break-all text-sm text-muted-foreground" role="status">
            {results.total} results for “{searchQuery}”
          </p>
        )}
      </div>

      {message && (
        <p className="rounded-lg border p-4 text-sm" role="status">
          {message}
        </p>
      )}
      {!message && isFetching && !results && (
        <p className="flex items-center gap-2 p-4 text-sm" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Searching…
        </p>
      )}
      {results && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList
            aria-label="Search results on this page"
            className="w-fit max-w-full"
          >
            <TabsTrigger value="all">
              All {counts.targets + counts.assets}
            </TabsTrigger>
            {categories.map(({ key, label }) => (
              <TabsTrigger key={key} value={key}>
                {label} {counts[key]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={tab} className="space-y-4">
            {visibleCategories.map((category) => (
              <SearchResultSection
                key={category.key}
                category={category}
                items={results.data[category.key]}
              />
            ))}
            {visibleCategories.length === 0 && (
              <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                No results on this page for the selected type.
              </p>
            )}
          </TabsContent>
        </Tabs>
      )}
      {results && results.pageCount > 1 && (
        <Pagination
          page={page}
          pageCount={results.pageCount}
          setPage={setPage}
        />
      )}
    </div>
  );
}

function Pagination({
  page,
  pageCount,
  setPage,
}: {
  page: number;
  pageCount: number;
  setPage: (value: number) => void;
}) {
  const getPaginationPages = () => {
    const pages = Array.from({ length: pageCount }, (_, i) => i + 1).filter(
      (p) => p === 1 || p === pageCount || Math.abs(p - page) <= 2,
    );

    const mergedPages: (number | '...')[] = [];

    pages.forEach((curr, i) => {
      if (i === 0 || curr - pages[i - 1] === 1) {
        mergedPages.push(curr);
      } else {
        mergedPages.push('...', curr);
      }
    });

    return mergedPages;
  };

  return (
    pageCount > 0 && (
      <div className="flex flex-row-reverse justify-end items-center">
        <PaginationNav aria-label="Search result pages">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => {
                  e.preventDefault();

                  if (page > 1) setPage(page - 1);
                }}
                aria-disabled={page <= 1}
                tabIndex={page <= 1 ? -1 : undefined}
                className={page <= 1 ? 'pointer-events-none opacity-50' : ''}
              />
            </PaginationItem>

            {getPaginationPages().map((p, idx) =>
              p === '...' ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={p}>
                  <PaginationLink
                    href="#"
                    isActive={p === page}
                    onClick={(e) => {
                      e.preventDefault();

                      setPage(p);
                    }}
                  >
                    {p}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}

            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => {
                  e.preventDefault();

                  if (page < pageCount) setPage(page + 1);
                }}
                aria-disabled={page >= pageCount}
                tabIndex={page >= pageCount ? -1 : undefined}
                className={
                  page >= pageCount ? 'pointer-events-none opacity-50' : ''
                }
              />
            </PaginationItem>
          </PaginationContent>
        </PaginationNav>
      </div>
    )
  );
}
