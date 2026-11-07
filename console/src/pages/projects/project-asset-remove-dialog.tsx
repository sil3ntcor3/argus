import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type ProjectAssetDto,
  useProjectsControllerRemoveAssets,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { invalidateProjectMembership } from './project-membership-cache';

export function ProjectAssetRemoveDialog({
  asset,
  projectId,
  workspaceId,
  onClose,
  restoreFocus,
}: {
  asset: ProjectAssetDto | null;
  projectId: string;
  workspaceId: string;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const queryClient = useQueryClient();
  const mutation = useProjectsControllerRemoveAssets();

  const close = () => {
    mutation.reset();
    onClose();
  };

  const remove = async () => {
    if (!asset || lock.current || workspaceId !== getGlobalWorkspaceId())
      return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await mutation
        .mutateAsync({ id: projectId, data: { assetIds: [asset.id] } })
        .catch(() => undefined);
      if (!result || workspaceId !== getGlobalWorkspaceId()) return;
      await invalidateProjectMembership(queryClient, projectId);
      if (workspaceId !== getGlobalWorkspaceId()) return;
      if (result.count) toast.success('Asset removed from the project.');
      else toast.info('The asset is already outside this project.');
      close();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={asset !== null}
      onOpenChange={(open) => {
        if (!open && !lock.current) close();
      }}
    >
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Remove project asset</DialogTitle>
          <DialogDescription>
            Remove {asset?.value} in target {asset?.targetValue} from this
            project? The asset stays in the workspace with its findings. If it
            matches saved scope, Argus adds an exclude rule so it stays out.
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p role="alert">Unable to remove the asset. Try again.</p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            aria-disabled={busy}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!lock.current) close();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            aria-disabled={busy}
            className="aria-disabled:opacity-50"
            onClick={() => void remove()}
          >
            {busy ? 'Removing…' : 'Remove asset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
