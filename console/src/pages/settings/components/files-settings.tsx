import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import useDebounce from '@/hooks/use-debounce';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  useArtifactsControllerGetMany,
  useArtifactsControllerGetUsage,
  type ArtifactUsageDto,
  type ArtifactsControllerGetManyScope,
} from '@/services/apis/gen/queries';
import { isAxiosError } from 'axios';
import { useEffect, useRef, useState } from 'react';

const PAGE_SIZE = 20;
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const freshRead = { staleTime: 0, refetchOnMount: 'always' as const };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(
    Math.floor(Math.log2(bytes) / 10),
    BYTE_UNITS.length - 1,
  );
  return `${(bytes / 1024 ** unit).toFixed(1)} ${BYTE_UNITS[unit]}`;
}

function StorageUsage({
  data,
  failed,
  onRetry,
}: {
  data?: ArtifactUsageDto;
  failed: boolean;
  onRetry: () => void;
}) {
  const summary = useRef<HTMLElement>(null);
  return (
    <section
      ref={summary}
      tabIndex={-1}
      aria-label="Workspace storage"
      className="rounded-md border p-4"
    >
      <h4 className="mb-3 text-sm font-semibold">Workspace storage</h4>
      {failed ? (
        <div className="flex items-center gap-3 text-sm">
          <p>Could not load storage usage.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              summary.current?.focus();
              onRetry();
            }}
          >
            Retry usage
          </Button>
        </div>
      ) : data ? (
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {(
            [
              ['Used', data.usedBytes],
              ['Quota', data.quotaBytes],
              ['Reserved', data.reservedBytes],
              ['Per-file limit', data.maxFileBytes],
            ] as const
          ).map(([label, bytes]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{formatBytes(bytes)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading storage usage…
        </p>
      )}
    </section>
  );
}

function isAccessDenied(error: unknown) {
  return (
    isAxiosError(error) &&
    (error.response?.status === 401 || error.response?.status === 403)
  );
}

function FileAccessError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border p-4 text-sm">
      <p>Could not verify access to Files.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry access
      </Button>
    </div>
  );
}

function WorkspaceFiles({
  canManage,
  onAccessDenied,
}: {
  canManage: boolean;
  onAccessDenied: () => void;
}) {
  const [scope, setScope] = useState<ArtifactsControllerGetManyScope>('mine');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const listRegion = useRef<HTMLDivElement>(null);
  const query = useDebounce(search.trim(), 250);
  const files = useArtifactsControllerGetMany(
    {
      page,
      limit: PAGE_SIZE,
      sortBy: 'createdAt',
      sortOrder: 'DESC',
      search: query,
      scope,
    },
    { query: freshRead },
  );
  const usage = useArtifactsControllerGetUsage({ query: freshRead });
  const denied = isAccessDenied(files.error) || isAccessDenied(usage.error);
  useEffect(() => {
    if (denied) onAccessDenied();
  }, [denied, onAccessDenied]);
  if (denied) {
    return (
      <FileAccessError
        onRetry={() => {
          onAccessDenied();
          void files.refetch();
          void usage.refetch();
        }}
      />
    );
  }
  // A cached result cannot confirm that the caller still has access.
  const data =
    files.isFetchedAfterMount && !files.isError ? files.data : undefined;
  const usageData =
    usage.isFetchedAfterMount && !usage.isError ? usage.data : undefined;
  const rows = data?.data ?? [];
  const nextDisabled =
    !data?.hasNextPage || search.trim() !== query || files.isFetching;

  return (
    <div className="min-w-0 space-y-4">
      <StorageUsage
        data={usageData}
        failed={usage.isError}
        onRetry={() => void usage.refetch()}
      />
      <div className="flex flex-wrap items-center gap-3">
        {canManage ? (
          <div role="group" aria-label="File scope" className="flex gap-2">
            {(['mine', 'all'] as const).map((option) => (
              <Button
                key={option}
                type="button"
                variant={scope === option ? 'default' : 'outline'}
                size="sm"
                aria-pressed={scope === option}
                onClick={() => {
                  setScope(option);
                  setPage(1);
                }}
              >
                {option === 'mine' ? 'My files' : 'All files'}
              </Button>
            ))}
          </div>
        ) : null}
        <Input
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          maxLength={255}
          className="min-w-0 flex-1 sm:max-w-xs"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </div>

      <div
        ref={listRegion}
        role="region"
        tabIndex={-1}
        aria-label="File results"
      >
        {files.isError ? (
          <div className="flex items-center gap-3 rounded-md border p-4 text-sm">
            <p>Could not load files.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                listRegion.current?.focus();
                void files.refetch();
              }}
            >
              Retry files
            </Button>
          </div>
        ) : !data ? (
          <p
            role="status"
            className="rounded-md border p-4 text-sm text-muted-foreground"
          >
            Loading files…
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            {query ? 'No files match your search.' : 'No files to display.'}
          </p>
        ) : (
          <div className="rounded-md border">
            <Table aria-label="Workspace files">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">File</TableHead>
                  <TableHead scope="col">Size</TableHead>
                  <TableHead scope="col">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((file) => (
                  <TableRow key={file.id}>
                    <TableCell className="max-w-48 break-all whitespace-normal sm:max-w-96">
                      <span className="font-medium">{file.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {file.source === 'agent' ? 'Agent' : 'Upload'}
                        {file.createdBy ? ` · ${file.createdBy.name}` : ''}
                      </span>
                    </TableCell>
                    <TableCell>{formatBytes(file.sizeBytes)}</TableCell>
                    <TableCell>
                      {dateFormat.format(new Date(file.createdAt))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <nav
        aria-label="File pages"
        className="flex items-center justify-end gap-3 text-sm"
      >
        <Button
          variant="outline"
          size="sm"
          aria-disabled={page === 1}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (page > 1) setPage(page - 1);
          }}
        >
          Previous page
        </Button>
        <span aria-live="polite">Page {page}</span>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={nextDisabled}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (!nextDisabled) setPage(page + 1);
          }}
        >
          Next page
        </Button>
      </nav>
    </div>
  );
}

/** Reset controls when workspace or management access changes. */
export default function FilesSettings() {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const { hasPermission, error, refetch } = usePermission();
  if (!selectedWorkspaceId || !hasPermission('artifact.read')) return null;
  if (error) return <FileAccessError onRetry={() => void refetch()} />;
  const canManage = hasPermission('artifact.manage');
  return (
    <WorkspaceFiles
      key={`${selectedWorkspaceId}:${canManage}`}
      canManage={canManage}
      onAccessDenied={refetch}
    />
  );
}
