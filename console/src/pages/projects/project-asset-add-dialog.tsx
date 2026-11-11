import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useProjectsControllerAddAssets,
  useProjectsControllerGetAssetCandidates,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { type ReactNode, useRef, useState } from 'react';
import { toast } from 'sonner';
import { invalidateProjectMembership } from './project-membership-cache';
import {
  escapeProjectAssetSearch,
  ProjectListSearch,
} from './project-list-search';

const maxSelectedAssets = 1000;

function AssetChoices({
  projectId,
  busy,
  failed,
  onAdd,
}: {
  projectId: string;
  busy: boolean;
  failed: boolean;
  onAdd: (ids: string[]) => void;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const atLimit = selected.length >= maxSelectedAssets;
  const candidates = useProjectsControllerGetAssetCandidates(
    projectId,
    {
      page,
      limit: 20,
      sortBy: 'value',
      sortOrder: 'ASC',
      search: escapeProjectAssetSearch(search),
    },
    { query: { retry: false } },
  );
  const status = isAxiosError(candidates.error)
    ? candidates.error.response?.status
    : undefined;

  let rows: ReactNode;
  if (status === 403 || status === 404) {
    rows = <p role="status">Project asset choices unavailable</p>;
  } else if (candidates.isError) {
    rows = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load asset choices</p>
        <Button variant="outline" onClick={() => void candidates.refetch()}>
          Retry choices
        </Button>
      </div>
    );
  } else if (!candidates.data) {
    rows = (
      <Skeleton
        role="status"
        aria-label="Loading asset choices"
        className="h-24 rounded-md"
      />
    );
  } else if (!candidates.data.data.length) {
    rows = <p role="status">No candidate assets on this page</p>;
  } else {
    rows = (
      <ul aria-label="Asset choices" className="divide-y rounded-md border">
        {candidates.data.data.map((asset) => (
          <li key={asset.id}>
            <label className="flex items-start gap-2 p-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(asset.id)}
                disabled={busy || (atLimit && !selected.includes(asset.id))}
                onChange={({ target: { checked } }) =>
                  setSelected((ids) => {
                    if (!checked) return ids.filter((id) => id !== asset.id);
                    return ids.length < maxSelectedAssets
                      ? [...ids, asset.id]
                      : ids;
                  })
                }
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {asset.value}
                <span className="ml-2 text-xs text-muted-foreground">
                  Asset {asset.id.slice(0, 8)}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-3">
      <ProjectListSearch
        label="Search candidate assets"
        regionLabel="Candidate asset search"
        placeholder="Asset value"
        maxLength={512}
        term={search}
        onChange={(next) => {
          setSearch(next);
          setPage(1);
        }}
      />
      {rows}
      <nav
        aria-label="Asset choice pages"
        className="flex flex-wrap items-center gap-2"
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
          Previous choices
        </Button>
        <span aria-live="polite">Page {page}</span>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={!candidates.data?.hasNextPage}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (candidates.data?.hasNextPage) setPage(page + 1);
          }}
        >
          Next choices
        </Button>
      </nav>
      {failed && (
        <p role="status">Unable to add the selected assets. Try again.</p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <span role="status">
          {selected.length} selected{atLimit && ' (limit reached)'}
        </span>
        <Button variant="ghost" disabled={busy} onClick={() => setSelected([])}>
          Clear selection
        </Button>
        <Button
          aria-disabled={
            busy || !selected.length || status === 403 || status === 404
          }
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (!busy && selected.length && status !== 403 && status !== 404)
              onAdd(selected);
          }}
        >
          {busy ? 'Adding…' : 'Add selected assets'}
        </Button>
      </div>
    </div>
  );
}

/** Adds existing workspace assets as manually managed project members. */
export function ProjectAssetAddDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const lock = useRef(false);
  const queryClient = useQueryClient();
  const mutation = useProjectsControllerAddAssets();
  const add = async (assetIds: string[]) => {
    const workspaceId = getGlobalWorkspaceId();
    if (!workspaceId || lock.current) return;
    lock.current = true;
    setAdding(true);
    try {
      const result = await mutation
        .mutateAsync({ id: projectId, data: { assetIds } })
        .catch(() => undefined);
      if (!result || workspaceId !== getGlobalWorkspaceId()) return;
      await invalidateProjectMembership(queryClient, projectId);
      if (workspaceId !== getGlobalWorkspaceId()) return;
      toast.success(`${result.count} assets added to the project.`);
      setOpen(false);
    } finally {
      lock.current = false;
      setAdding(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (lock.current) return;
        if (next) mutation.reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Add assets
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add project assets</DialogTitle>
          <DialogDescription>
            Choose existing workspace assets to add as manual members.
          </DialogDescription>
        </DialogHeader>
        <AssetChoices
          projectId={projectId}
          busy={adding}
          failed={mutation.isError}
          onAdd={(assetIds) => void add(assetIds)}
        />
      </DialogContent>
    </Dialog>
  );
}
