import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  useArtifactFoldersControllerGetById,
  useArtifactFoldersControllerGetMany,
  useArtifactsControllerGetMany,
  useArtifactsControllerGetUsage,
  useArtifactsControllerRemove,
  type ArtifactListItemDto,
  type ArtifactUsageDto,
  type ArtifactsControllerGetManyScope,
  type ArtifactsControllerGetManySortBy,
  type ArtifactsControllerGetManySortOrder,
} from '@/services/apis/gen/queries';
import {
  getGlobalWorkspaceId,
  subscribeGlobalWorkspaceId,
} from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Download,
  LayoutGrid,
  List,
  Share2,
  Trash2,
} from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { FileFolderNavigation } from './file-folder-navigation';
import { FileIcon } from './file-icon';
import { FileSharingDialog } from './file-sharing-dialog';

const DEFAULT_PAGE_SIZE = 20;
const FILE_PAGE_SIZES = [5, 10, 20, 50, 100] as const;
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const freshRead = { staleTime: 0, refetchOnMount: 'always' as const };
const FILE_VIEW_KEY = 'argus.files.view';
const FILE_VIEWS = [
  { id: 'list', label: 'List view', Icon: List },
  { id: 'grid', label: 'Grid view', Icon: LayoutGrid },
] as const;
type FileView = (typeof FILE_VIEWS)[number]['id'];
const FILE_SCOPES = [
  { value: 'mine', label: 'My files' },
  { value: 'shared', label: 'Shared with me' },
  { value: 'all', label: 'All files' },
] as const;
const FILE_SORT_FIELDS = [
  { value: 'name', label: 'Name' },
  { value: 'updatedAt', label: 'Modified' },
  { value: 'createdAt', label: 'Created' },
  { value: 'sizeBytes', label: 'Size' },
] as const satisfies ReadonlyArray<{
  value: ArtifactsControllerGetManySortBy;
  label: string;
}>;
const FOLDER_UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/i;

function readFileView(): FileView {
  try {
    return localStorage.getItem(FILE_VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

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

/** Render the actions allowed for the file in the current list scope. */
function FileActions({
  file,
  canDownload,
  canShare,
  canDelete,
  downloading,
  deleting,
  focusAfterDelete,
  onDownload,
  onShare,
  onDelete,
}: {
  file: ArtifactListItemDto;
  canDownload: boolean;
  canShare: boolean;
  canDelete: boolean;
  downloading: boolean;
  deleting: boolean;
  focusAfterDelete: RefObject<HTMLElement | null>;
  onDownload: () => void;
  onShare: (trigger: HTMLButtonElement) => void;
  onDelete: () => void;
}) {
  const confirmed = useRef(false);
  return (
    <div className="flex justify-end gap-1">
      {canShare ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Share ${file.name}`}
          title="Share"
          disabled={deleting || downloading}
          onClick={(event) => onShare(event.currentTarget)}
        >
          <Share2 aria-hidden="true" className="size-4" />
        </Button>
      ) : null}
      {canDownload ? (
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

/** Render the same page of files and actions in a responsive card layout. */
function FileGrid({
  rows,
  dateField,
  renderActions,
}: {
  rows: ArtifactListItemDto[];
  dateField: 'createdAt' | 'updatedAt';
  renderActions: (file: ArtifactListItemDto) => ReactNode;
}) {
  return (
    <ul
      role="list"
      aria-label="Workspace file grid"
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-3"
    >
      {rows.map((file) => (
        <li
          key={file.id}
          className="min-w-0 overflow-hidden rounded-md border bg-card"
        >
          <div className="flex h-24 items-center justify-center bg-muted/50">
            <FileIcon
              name={file.name}
              mimeType={file.mimeType}
              className="size-10"
            />
          </div>
          <div className="space-y-1 p-3">
            <p className="break-all text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.sizeBytes)} ·{' '}
              {dateField === 'updatedAt' ? 'Modified ' : ''}
              {dateFormat.format(new Date(file[dateField]))}
            </p>
            <p className="break-all text-xs text-muted-foreground">
              {file.source === 'agent' ? 'Agent' : 'Upload'}
              {file.createdBy ? ` · ${file.createdBy.name}` : ''}
            </p>
            {renderActions(file)}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Browse workspace files with scope-specific folders and actions. */
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
  const folderId = useSearch({
    strict: false,
    select: (search) => {
      const folder = (search as Record<string, unknown>).folder;
      return typeof folder === 'string' &&
        folder.length === 36 &&
        FOLDER_UUID.test(folder)
        ? folder.toLowerCase()
        : undefined;
    },
  });
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] =
    useState<ArtifactsControllerGetManySortBy>('createdAt');
  const [sortOrder, setSortOrder] =
    useState<ArtifactsControllerGetManySortOrder>('DESC');
  const dateField = sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt';
  const [pagination, setPagination] = useState({ folderId, page: 1 });
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const page = pagination.folderId === folderId ? pagination.page : 1;
  if (pagination.folderId !== folderId) {
    setPagination({ folderId, page: 1 });
  }
  const [view, setView] = useState(readFileView);
  const [downloading, setDownloading] = useState(false);
  const [sharingFile, setSharingFile] = useState<ArtifactListItemDto | null>(
    null,
  );
  const sharingTrigger = useRef<HTMLElement | null>(null);
  if (sharingFile && !canWrite) setSharingFile(null);
  const queryClient = useQueryClient();
  const listRegion = useRef<HTMLDivElement>(null);
  const folderRegion = useRef<HTMLDivElement>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const pendingDelete = useRef(false);
  const queryOptions = { ...freshRead, meta: { workspaceId } };
  const query = useDebounce(search.trim(), 250);
  const browsingFolders = scope === 'mine' && !query;
  // Separate disabled keys make returning to browse require a fresh response.
  const folders = useArtifactFoldersControllerGetMany(
    folderId ? { parentFolderId: folderId } : undefined,
    {
      query: {
        ...queryOptions,
        enabled: browsingFolders,
        ...(!browsingFolders && { queryKey: ['files-folders-disabled'] }),
      },
    },
  );
  const folderDetail = useArtifactFoldersControllerGetById(folderId ?? '', {
    query: {
      ...queryOptions,
      enabled: browsingFolders && !!folderId,
      ...(!browsingFolders && { queryKey: ['files-folder-detail-disabled'] }),
    },
  });
  const files = useArtifactsControllerGetMany(
    {
      page,
      limit: pageSize,
      sortBy,
      sortOrder,
      search: query,
      scope,
      parentFolderId: browsingFolders ? (folderId ?? 'root') : undefined,
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
            setPage(Math.max(page - 1, 1));
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
  const denied =
    isAccessDenied(files.error) ||
    isAccessDenied(usage.error) ||
    (browsingFolders &&
      (isAccessDenied(folders.error) ||
        (!!folderId && isAccessDenied(folderDetail.error))));
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
          if (browsingFolders) retryFolders();
        }}
      />
    );
  }
  // A cached result cannot confirm that the caller still has access.
  const usageData =
    usage.isFetchedAfterMount && !usage.isError ? usage.data : undefined;
  const nextDisabled =
    !currentFiles?.hasNextPage || search.trim() !== query || files.isFetching;

  function retryFolders() {
    folderRegion.current?.focus();
    void folders.refetch();
    if (folderId) void folderDetail.refetch();
  }

  function setPage(next: number) {
    setPagination({ folderId, page: next });
  }

  function setFolderLocation(id?: string, replace = false) {
    void navigate({
      to: '/settings/$tab',
      params: { tab: 'files' },
      search: (previous) => ({ ...previous, folder: id }),
      replace,
      resetScroll: false,
    });
  }

  function openFolder(id?: string) {
    setFolderLocation(id);
    folderRegion.current?.focus();
  }

  function chooseView(next: FileView) {
    setView(next);
    try {
      localStorage.setItem(FILE_VIEW_KEY, next);
    } catch {
      // The selected view still works when browser storage is unavailable.
    }
  }

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

  /** Share action handling across table and grid views. */
  function renderFileActions(file: ArtifactListItemDto) {
    return (
      <FileActions
        file={file}
        canDownload={file.isOwner || scope === 'shared'}
        canShare={canWrite && file.isOwner}
        canDelete={canManage || (canWrite && file.isOwner)}
        downloading={downloading}
        deleting={removeFile.isPending}
        focusAfterDelete={listRegion}
        onDownload={() => void downloadFile(file)}
        onShare={(trigger) => {
          sharingTrigger.current = trigger;
          setSharingFile(file);
        }}
        onDelete={() => {
          if (pendingDelete.current || getGlobalWorkspaceId() !== workspaceId)
            return;
          pendingDelete.current = true;
          removeFile.mutate({ id: file.id });
        }}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {sharingFile && canWrite && (
        <FileSharingDialog
          key={sharingFile.id}
          file={sharingFile}
          workspaceId={workspaceId}
          focusAfterClose={sharingTrigger}
          onClose={() => setSharingFile(null)}
          onAccessDenied={onAccessDenied}
        />
      )}
      <StorageUsage
        data={usageData}
        failed={usage.isError}
        onRetry={() => void usage.refetch()}
      />
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="File scope"
          className="flex flex-wrap gap-2"
        >
          {FILE_SCOPES.filter(({ value }) => value !== 'all' || canManage).map(
            ({ value, label }) => (
              <Button
                key={value}
                type="button"
                variant={scope === value ? 'default' : 'outline'}
                size="sm"
                aria-pressed={scope === value}
                onClick={() => {
                  if (value !== scope && folderId) {
                    setFolderLocation(undefined, true);
                  }
                  setScope(value);
                  setPage(1);
                }}
              >
                {label}
              </Button>
            ),
          )}
        </div>
        <Input
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          maxLength={255}
          className="min-w-36 flex-1 sm:max-w-xs"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <div role="group" aria-label="File sorting" className="flex gap-1">
          <Select
            value={sortBy}
            onValueChange={(value) => {
              const field = FILE_SORT_FIELDS.find(
                (option) => option.value === value,
              );
              if (!field) return;
              setSortBy(field.value);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="Sort by" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILE_SORT_FIELDS.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={
              sortOrder === 'ASC' ? 'Sort descending' : 'Sort ascending'
            }
            title={sortOrder === 'ASC' ? 'Ascending' : 'Descending'}
            onClick={() => {
              setSortOrder((order) => (order === 'ASC' ? 'DESC' : 'ASC'));
              setPage(1);
            }}
          >
            {sortOrder === 'ASC' ? (
              <ArrowUpNarrowWide aria-hidden="true" className="size-4" />
            ) : (
              <ArrowDownWideNarrow aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
        <div role="group" aria-label="File view" className="flex gap-1">
          {FILE_VIEWS.map(({ id, label, Icon }) => (
            <Button
              key={id}
              type="button"
              variant={view === id ? 'default' : 'outline'}
              size="icon"
              aria-label={label}
              aria-pressed={view === id}
              title={label}
              onClick={() => chooseView(id)}
            >
              <Icon aria-hidden="true" className="size-4" />
            </Button>
          ))}
        </div>
      </div>

      {browsingFolders ? (
        <div
          ref={folderRegion}
          role="region"
          tabIndex={-1}
          aria-label="Folder navigation"
          className="empty:hidden focus:empty:block"
        >
          <FileFolderNavigation
            folderId={folderId}
            path={
              folderDetail.isFetchedAfterMount && !folderDetail.isError
                ? folderDetail.data?.path
                : undefined
            }
            folders={
              folders.isFetchedAfterMount && !folders.isError
                ? folders.data
                : undefined
            }
            failed={folders.isError || (!!folderId && folderDetail.isError)}
            onOpen={openFolder}
            onRetry={retryFolders}
          />
        </div>
      ) : null}

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
        ) : view === 'grid' ? (
          <FileGrid
            rows={rows}
            dateField={dateField}
            renderActions={renderFileActions}
          />
        ) : (
          <div className="rounded-md border">
            <Table aria-label="Workspace files">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">File</TableHead>
                  <TableHead scope="col">Size</TableHead>
                  <TableHead scope="col">
                    {dateField === 'updatedAt' ? 'Modified' : 'Created'}
                  </TableHead>
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
                      {dateFormat.format(new Date(file[dateField]))}
                    </TableCell>
                    <TableCell>{renderFileActions(file)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <nav
        aria-label="File pages"
        className="flex flex-wrap items-center justify-end gap-3 text-sm"
      >
        {currentFiles && currentFiles.total > 0 && rows.length > 0 ? (
          <span className="text-muted-foreground">
            {(page - 1) * pageSize + 1}–{(page - 1) * pageSize + rows.length} of{' '}
            {currentFiles.total}
          </span>
        ) : null}
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-muted-foreground">
            Files per page
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              const size = FILE_PAGE_SIZES.find(
                (option) => String(option) === value,
              );
              if (size === undefined) return;
              setPageSize(size);
              setPage(1);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Files per page"
              className="w-20"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILE_PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3">
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
        </div>
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
