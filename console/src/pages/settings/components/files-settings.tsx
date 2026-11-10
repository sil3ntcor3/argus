import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { handleServerError } from '@/lib/handle-server-error';
import {
  artifactsControllerDownload,
  artifactsControllerRemove,
  getArtifactsControllerGetManyQueryKey,
  getArtifactsControllerGetUsageQueryKey,
  useArtifactsControllerGetMany,
  useArtifactsControllerGetUsage,
  useArtifactsControllerRemove,
  type ArtifactListItemDto,
  type ArtifactUsageDto,
  type ArtifactsControllerGetManyScope,
} from '@/services/apis/gen/queries';
import {
  getGlobalWorkspaceId,
  subscribeGlobalWorkspaceId,
} from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { Download, Trash2 } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileIcon } from './file-icon';

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

function FileActions({
  file,
  canDelete,
  downloading,
  deleting,
  focusAfterDelete,
  onDownload,
  onDelete,
}: {
  file: ArtifactListItemDto;
  canDelete: boolean;
  downloading: boolean;
  deleting: boolean;
  focusAfterDelete: RefObject<HTMLElement | null>;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const confirmed = useRef(false);
  return (
    <div className="flex justify-end gap-1">
      {file.isOwner ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Download ${file.name}`}
          title="Download"
          aria-disabled={downloading || deleting}
          onClick={onDownload}
        >
          <Download aria-hidden="true" className="size-4" />
        </Button>
      ) : null}
      {canDelete ? (
        <ConfirmDialog
          title="Delete file"
          description={`Permanently delete ${file.name}?`}
          confirmText="Delete file"
          focusCancel
          disabled={deleting}
          onConfirm={() => {
            confirmed.current = true;
            onDelete();
          }}
          onCloseAutoFocus={(event) => {
            if (confirmed.current && focusAfterDelete.current) {
              event.preventDefault();
              focusAfterDelete.current.focus();
            }
            confirmed.current = false;
          }}
          trigger={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Delete ${file.name}`}
              title="Delete"
              disabled={deleting}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function WorkspaceFiles({
  workspaceId,
  canManage,
  canWrite,
  onAccessDenied,
}: {
  workspaceId: string;
  canManage: boolean;
  canWrite: boolean;
  onAccessDenied: () => void;
}) {
  const [scope, setScope] = useState<ArtifactsControllerGetManyScope>('mine');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const queryClient = useQueryClient();
  const listRegion = useRef<HTMLDivElement>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const pendingDelete = useRef(false);
  const queryOptions = { ...freshRead, meta: { workspaceId } };
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
    { query: queryOptions },
  );
  const usage = useArtifactsControllerGetUsage({ query: queryOptions });
  const currentFiles =
    files.isFetchedAfterMount && !files.isError ? files.data : undefined;
  const rows = currentFiles?.data ?? [];
  const removeFile = useArtifactsControllerRemove({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: async ({ id }) => {
        if (!listRegion.current || getGlobalWorkspaceId() !== workspaceId) {
          throw new Error('The selected workspace changed');
        }
        return artifactsControllerRemove(id);
      },
      onSuccess: async (_response, { id }) => {
        const current =
          !!listRegion.current && getGlobalWorkspaceId() === workspaceId;
        if (current) {
          if (rows.length === 1 && rows[0].id === id) {
            setPage((previous) => Math.max(previous - 1, 1));
          }
          toast.success('File deleted');
        }
        await Promise.all(
          [
            getArtifactsControllerGetManyQueryKey(),
            getArtifactsControllerGetUsageQueryKey(),
          ].map((queryKey) =>
            queryClient.invalidateQueries({
              queryKey,
              predicate: (cached) => cached.meta?.workspaceId === workspaceId,
              refetchType: current ? 'active' : 'none',
            }),
          ),
        );
      },
      onError: (error) => {
        if (!listRegion.current || getGlobalWorkspaceId() !== workspaceId)
          return;
        if (isAccessDenied(error)) onAccessDenied();
        handleServerError(error);
      },
      onSettled: () => {
        pendingDelete.current = false;
      },
    },
  });
  const denied = isAccessDenied(files.error) || isAccessDenied(usage.error);
  useEffect(() => {
    if (denied) onAccessDenied();
  }, [denied, onAccessDenied]);
  useEffect(() => {
    const abortDownload = () => downloadRequest.current?.abort();
    const unsubscribe = subscribeGlobalWorkspaceId(abortDownload);
    return () => {
      unsubscribe();
      abortDownload();
    };
  }, []);
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
  const usageData =
    usage.isFetchedAfterMount && !usage.isError ? usage.data : undefined;
  const nextDisabled =
    !currentFiles?.hasNextPage || search.trim() !== query || files.isFetching;

  async function downloadFile(file: ArtifactListItemDto) {
    if (
      getGlobalWorkspaceId() !== workspaceId ||
      downloadRequest.current ||
      pendingDelete.current
    )
      return;
    const request = new AbortController();
    downloadRequest.current = request;
    setDownloading(true);
    try {
      const { url } = await artifactsControllerDownload(
        file.id,
        undefined,
        request.signal,
      );
      if (
        !listRegion.current ||
        request.signal.aborted ||
        getGlobalWorkspaceId() !== workspaceId
      )
        return;
      const target = new URL(url, window.location.origin);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('Invalid file download URL');
      }
      const link = document.createElement('a');
      link.href = target.href;
      link.rel = 'noreferrer';
      link.download = '';
      link.click();
    } catch (error) {
      if (
        listRegion.current &&
        !request.signal.aborted &&
        getGlobalWorkspaceId() === workspaceId
      ) {
        if (isAccessDenied(error)) onAccessDenied();
        handleServerError(error);
      }
    } finally {
      downloadRequest.current = null;
      setDownloading(false);
    }
  }

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
        ) : !currentFiles ? (
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
                  <TableHead scope="col" className="text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((file) => (
                  <TableRow key={file.id}>
                    <TableCell className="max-w-48 break-all whitespace-normal sm:max-w-96">
                      <div className="flex items-start gap-2">
                        <FileIcon name={file.name} mimeType={file.mimeType} />
                        <div className="min-w-0">
                          <span className="font-medium">{file.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {file.source === 'agent' ? 'Agent' : 'Upload'}
                            {file.createdBy ? ` · ${file.createdBy.name}` : ''}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{formatBytes(file.sizeBytes)}</TableCell>
                    <TableCell>
                      {dateFormat.format(new Date(file.createdAt))}
                    </TableCell>
                    <TableCell>
                      <FileActions
                        file={file}
                        canDelete={canManage || (canWrite && file.isOwner)}
                        downloading={downloading}
                        deleting={removeFile.isPending}
                        focusAfterDelete={listRegion}
                        onDownload={() => void downloadFile(file)}
                        onDelete={() => {
                          if (
                            pendingDelete.current ||
                            getGlobalWorkspaceId() !== workspaceId
                          )
                            return;
                          pendingDelete.current = true;
                          removeFile.mutate({ id: file.id });
                        }}
                      />
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
      workspaceId={selectedWorkspaceId}
      canManage={canManage}
      canWrite={hasPermission('artifact.write')}
      onAccessDenied={refetch}
    />
  );
}
