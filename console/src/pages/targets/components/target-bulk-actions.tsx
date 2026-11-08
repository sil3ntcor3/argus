import { scanScheduleOptions } from '@/components/scan-schedule-options';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  JobStatus,
  TargetType,
  targetsControllerDeleteTarget,
  targetsControllerGetTargetById,
  targetsControllerReScanTarget,
  targetsControllerUpdateTarget,
  type GetManyTargetResponseDto,
  type UpdateTargetDtoScanSchedule,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { CalendarClock, ChevronDown, RefreshCw, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

type BulkAction =
  | {
      kind: 'schedule';
      ids: string[];
      scanSchedule: UpdateTargetDtoScanSchedule;
    }
  | { kind: 'rediscover'; ids: string[]; busyCount: number }
  | { kind: 'delete'; ids: string[] };

type ActionTarget = Pick<
  GetManyTargetResponseDto,
  'id' | 'value' | 'type' | 'integrationId'
> & { status: string };

/** Skip active discovery and Git organizations without an integration. */
function canRediscover({ status, type, integrationId }: ActionTarget) {
  return (
    status === JobStatus.completed &&
    (type !== TargetType.GIT_ORG || Boolean(integrationId))
  );
}

/** A transport error may follow a committed request. */
function writeOutcomeUnknown(error: unknown) {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined || status === 408 || status >= 500;
}

function targetCount(count: number) {
  return `${count} ${count === 1 ? 'target' : 'targets'}`;
}

/** Runs selected actions through the existing single-target APIs. */
export function TargetBulkActions({
  targets,
  workspaceId,
  canDelete,
  focusTargets,
  onComplete,
  onClear,
}: {
  targets: ActionTarget[];
  workspaceId: string;
  canDelete: boolean;
  focusTargets: () => void;
  onComplete: (updatedIds: string[]) => void;
  onClear: () => void;
}) {
  const queryClient = useQueryClient();
  const mutationScope = ['target-settings', workspaceId];
  const mutationKey = [...mutationScope, 'bulk'];
  const mutationFilter = { mutationKey: mutationScope };
  const busy = useIsMutating(mutationFilter) > 0;
  const [open, setOpen] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const ids = targets.map(({ id }) => id);
  const ready = targets.filter(canRediscover).map(({ id }) => id);
  const mutation = useMutation({
    mutationKey,
    networkMode: 'always',
    retry: false,
    mutationFn: async (action: BulkAction) => {
      const updated: string[] = [];
      const unconfirmed: string[] = [];
      let failed = 0;
      for (const id of action.ids) {
        if (workspaceId !== getGlobalWorkspaceId()) break;
        if (action.kind === 'rediscover') {
          try {
            const target = await targetsControllerGetTargetById(id, {
              headers: { 'Cache-Control': 'no-cache' },
            });
            if (!canRediscover(target)) continue;
          } catch {
            failed++;
            continue;
          }
          if (workspaceId !== getGlobalWorkspaceId()) break;
        }

        try {
          if (action.kind === 'schedule')
            await targetsControllerUpdateTarget(id, {
              scanSchedule: action.scanSchedule,
            });
          else if (action.kind === 'rediscover')
            await targetsControllerReScanTarget(id);
          else await targetsControllerDeleteTarget(id);
          updated.push(id);
        } catch (error) {
          if (action.kind !== 'schedule' && writeOutcomeUnknown(error))
            unconfirmed.push(id);
          else failed++;
        }
      }
      const skipped =
        action.ids.length -
        updated.length -
        failed -
        unconfirmed.length +
        (action.kind === 'rediscover' ? action.busyCount : 0);
      return { updated, failed, skipped, unconfirmed };
    },
    onSuccess: ({ updated, failed, skipped, unconfirmed }, action) => {
      const current = workspaceId === getGlobalWorkspaceId();
      void queryClient.invalidateQueries({
        queryKey: ['targets', workspaceId],
        refetchType: current ? 'active' : 'none',
      });
      onComplete([...updated, ...unconfirmed]);
      if (!current) return;
      const verb = {
        schedule: 'Schedule set on',
        rediscover: 'Re-discovery requested for',
        delete: 'Deleted',
      }[action.kind];
      const message =
        `${verb} ${targetCount(updated.length)}.` +
        (failed ? ` ${failed} failed.` : '') +
        (unconfirmed.length ? ` ${unconfirmed.length} unconfirmed.` : '') +
        (skipped ? ` ${skipped} skipped.` : '');
      if (failed || skipped || unconfirmed.length) toast.error(message);
      else toast.success(message);
    },
  });

  /** Recheck the workspace and pending operations when dispatching. */
  function run(action: BulkAction) {
    if (
      action.ids.length > 0 &&
      (action.kind !== 'delete' || canDelete) &&
      workspaceId === getGlobalWorkspaceId() &&
      !queryClient.isMutating(mutationFilter)
    )
      mutation.mutate(action);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 normal-case">
      <span className="text-sm font-medium">
        {targetCount(ids.length)} selected
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={!ready.length}
        aria-disabled={busy || !ready.length}
        className="aria-disabled:opacity-50"
        onClick={() =>
          run({
            kind: 'rediscover',
            ids: ready,
            busyCount: ids.length - ready.length,
          })
        }
      >
        <RefreshCw className="size-4" />
        Re-discover
      </Button>
      <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !busy)}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-disabled={busy}
            className="aria-disabled:opacity-50"
          >
            <CalendarClock className="size-4" />
            {busy ? 'Working…' : 'Schedule'}
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Scan schedule</DropdownMenuLabel>
          {scanScheduleOptions.map(({ value, label }) => (
            <DropdownMenuItem
              key={value}
              onSelect={() =>
                run({ kind: 'schedule', ids, scanSchedule: value })
              }
            >
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {canDelete && (
        <ConfirmDialog
          key={[...ids].sort().join(',')}
          title={`Delete ${targetCount(ids.length)}`}
          description="Permanently delete these targets and their associated assets and findings."
          typeToConfirm="delete"
          onConfirm={() => {
            confirmed.current = true;
            run({ kind: 'delete', ids });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = deleteTrigger.current;
            if (!confirmed.current && trigger?.isConnected) trigger.focus();
            else focusTargets();
            confirmed.current = false;
          }}
          trigger={
            <Button
              ref={deleteTrigger}
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={busy}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          }
        >
          <ul className="max-h-40 space-y-1 overflow-y-auto break-all text-sm">
            {targets.map(({ id, value }) => (
              <li key={id}>{value}</li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label="Clear selection"
        aria-disabled={busy}
        className="aria-disabled:opacity-50"
        onClick={() => {
          if (!queryClient.isMutating(mutationFilter)) onClear();
        }}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
