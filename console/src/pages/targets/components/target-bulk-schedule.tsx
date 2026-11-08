import { scanScheduleOptions } from '@/components/scan-schedule-options';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  targetsControllerUpdateTarget,
  type UpdateTargetDtoScanSchedule,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { CalendarClock, ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/** Updates selected targets through the existing single-target schedule API. */
export function TargetBulkSchedule({
  ids,
  workspaceId,
  onComplete,
  onClear,
}: {
  ids: string[];
  workspaceId: string;
  onComplete: (updatedIds: string[]) => void;
  onClear: () => void;
}) {
  const queryClient = useQueryClient();
  const mutationScope = ['target-settings', workspaceId];
  const mutationKey = [...mutationScope, 'bulk-schedule'];
  const mutationFilter = { mutationKey: mutationScope };
  const busy = useIsMutating(mutationFilter) > 0;
  const [open, setOpen] = useState(false);
  const schedule = useMutation({
    mutationKey,
    networkMode: 'always',
    retry: false,
    mutationFn: async ({
      ids,
      scanSchedule,
    }: {
      ids: string[];
      scanSchedule: UpdateTargetDtoScanSchedule;
    }) => {
      const updated: string[] = [];
      let failed = 0;
      for (const id of ids) {
        if (workspaceId !== getGlobalWorkspaceId()) break;
        try {
          await targetsControllerUpdateTarget(id, { scanSchedule });
          updated.push(id);
        } catch {
          failed++;
        }
      }
      return { updated, failed, skipped: ids.length - updated.length - failed };
    },
    onSuccess: ({ updated, failed, skipped }) => {
      const current = workspaceId === getGlobalWorkspaceId();
      void queryClient.invalidateQueries({
        queryKey: ['targets', workspaceId],
        refetchType: current ? 'active' : 'none',
      });
      onComplete(updated);
      if (!current) return;
      const noun = updated.length === 1 ? 'target' : 'targets';
      const message =
        `Schedule set on ${updated.length} ${noun}.` +
        (failed ? ` ${failed} failed.` : '') +
        (skipped ? ` ${skipped} skipped.` : '');
      if (failed || skipped) toast.error(message);
      else toast.success(message);
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2 normal-case">
      <span className="text-sm font-medium">
        {ids.length} {ids.length === 1 ? 'target' : 'targets'} selected
      </span>
      <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !busy)}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-disabled={busy}
            className="aria-disabled:opacity-50"
          >
            <CalendarClock className="size-4" />
            {busy ? 'Scheduling…' : 'Schedule'}
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Scan schedule</DropdownMenuLabel>
          {scanScheduleOptions.map(({ value, label }) => (
            <DropdownMenuItem
              key={value}
              onSelect={() => {
                if (
                  workspaceId === getGlobalWorkspaceId() &&
                  !queryClient.isMutating(mutationFilter)
                ) {
                  schedule.mutate({ ids, scanSchedule: value });
                }
              }}
            >
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
