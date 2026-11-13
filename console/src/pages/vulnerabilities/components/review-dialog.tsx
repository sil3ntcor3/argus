import { useId, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SeverityBadge } from '@/components/ui/severity-badge';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  vulnerabilitiesControllerApprove, vulnerabilitiesControllerReject, vulnerabilitiesControllerMerge,
  vulnerabilitiesControllerBulkApprove, vulnerabilitiesControllerBulkReject, vulnerabilitiesControllerDuplicates,
  type ApproveVulnerabilityDto, type BulkReviewResultDto, type MergeVulnerabilityResponseDto, type VulnerabilityReviewResultDto,
} from '@/services/apis/gen/queries';
import { useReviewWrite } from '../use-review-write';

type Mode = 'approve' | 'reject' | 'merge';
type ReviewOutcome = BulkReviewResultDto | MergeVulnerabilityResponseDto | VulnerabilityReviewResultDto;
type Props = { ids: string[]; mode: Mode; trigger: ReactNode; reload: () => Promise<unknown>;
  onSuccess?: (result: ReviewOutcome) => void; onDiscard?: () => void; onMerged?: (targetId: string) => void | Promise<void> };

function ScopedReview({ workspaceId, ids: inputIds, mode, trigger, reload, onSuccess, onDiscard, onMerged }: Props & { workspaceId: string }) {
  const permission = usePermission();
  const canWrite = !permission.isLoading && !permission.error && permission.hasPermission('vulnerability.write');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState('keep');
  const [target, setTarget] = useState('');
  const field = useId(); const triggerRef = useRef<HTMLButtonElement>(null);
  const ids = [...new Set(inputIds.map(id => id.toLowerCase()))].sort();
  const single = ids.length === 1;
  const action = mode === 'approve' ? 'Approve' : mode === 'reject' ? 'Reject' : 'Merge';
  const title = `${action} ${single ? 'proposal' : 'proposals'}`;
  const candidates = useQuery({
    queryKey: ['finding-review-duplicates', workspaceId, ids[0]],
    enabled: open && mode === 'merge' && single && canWrite,
    retry: false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => {
      if (getGlobalWorkspaceId() !== workspaceId) throw new Error('Workspace changed');
      return vulnerabilitiesControllerDuplicates(ids[0], { signal, timeout: 20_000 });
    },
  });
  const reset = () => { setNote(''); setSeverity('keep'); setTarget(''); };
  const write = useReviewWrite<undefined, ReviewOutcome>({ workspaceId, canWrite, partial: !single,
    onPersisted: async result => { if ('targetVulnerabilityId' in result) await onMerged?.(result.targetVulnerabilityId); },
    perform: async (_input: undefined, request): Promise<ReviewOutcome> => {
      const optionalNote = note.trim() ? { note: note.trim() } : {};
      if (mode === 'merge') return vulnerabilitiesControllerMerge(ids[0], { targetVulnerabilityId: target }, request);
      if (mode === 'reject') return single
        ? vulnerabilitiesControllerReject(ids[0], { note: note.trim() }, request)
        : vulnerabilitiesControllerBulkReject({ ids, note: note.trim() }, request);
      return single ? vulnerabilitiesControllerApprove(ids[0], {
        ...optionalNote, ...(severity !== 'keep' ? { severity: severity as ApproveVulnerabilityDto['severity'] } : {}),
      }, request) : vulnerabilitiesControllerBulkApprove({ ids, ...optionalNote }, request);
    },
    onSuccess: result => {
      if ('reviewed' in result) toast.success(`${result.reviewed.length} reviewed · ${result.skipped.length} skipped`, {
        description: result.skipped.length ? 'Missing or no-longer-pending proposals were skipped. Refresh the list before another review.' : undefined,
      });
      else toast.success(mode === 'merge' ? 'Proposal merged; evidence and discussion retained.' : `Proposal ${mode === 'approve' ? 'approved' : 'rejected'}.`);
      setOpen(false); reset(); onSuccess?.(result);
    },
    onDiscard: () => { reset(); setOpen(false); onDiscard?.(); },
  });
  if (!canWrite) return null;
  const invalid = !ids.length || ids.length > 200 || note.length > 5000 ||
    (mode === 'reject' && !note.trim()) || (mode === 'merge' && (!single || !target || candidates.isFetching || candidates.isError || !candidates.data?.data.some(row => row.id === target)));
  return <Dialog open={open} onOpenChange={next => { if (!write.busy) { setOpen(next); if (!next && !write.uncertain) reset(); } }}>
    <DialogTrigger asChild ref={triggerRef}>{trigger}</DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={event => {
      if (getGlobalWorkspaceId() !== workspaceId) { event.preventDefault(); return; }
      if (!triggerRef.current?.isConnected || triggerRef.current.disabled) {
        event.preventDefault(); document.querySelector<HTMLElement>('[data-finding-review-focus]')?.focus();
      }
    }}>
      <form className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); if (!invalid) void write.run(undefined); }}>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>
          {mode === 'approve' ? `Approve ${ids.length} proposal(s) as findings detected now, with the saved workspace SLA. Review the attached proof first.`
            : mode === 'reject' ? 'Keep the proposal and its proof as rejected. It will not contribute to finding counts.'
              : 'Move this proposal’s proof, discussion and recorded history into an approved finding on the same asset. The proposal is then removed.'}
        </DialogDescription></DialogHeader>
        {mode === 'approve' && single && <div className="space-y-2"><Label htmlFor={`${field}-severity`}>Severity</Label>
          <select id={`${field}-severity`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={severity}
            disabled={write.busy || write.uncertain} onChange={event => setSeverity(event.target.value)}>
            <option value="keep">Keep proposed severity</option>{['critical', 'high', 'medium', 'low', 'info'].map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
          </select></div>}
        {mode !== 'merge' && <div className="space-y-2"><Label htmlFor={`${field}-note`}>{mode === 'reject' ? 'Rejection reason' : 'Review note (optional)'}</Label>
          <Textarea id={`${field}-note`} rows={3} maxLength={5000} value={note} disabled={write.busy || write.uncertain}
            onChange={event => setNote(event.target.value)} required={mode === 'reject'} /></div>}
        {mode === 'merge' && <fieldset disabled={write.busy || write.uncertain} className="min-w-0 space-y-2">
          <legend className="mb-2 text-sm font-medium">Approved duplicate candidates</legend>
          {candidates.isPending && <p role="status" className="text-sm">Loading duplicate candidates…</p>}
          {candidates.isError ? <div><p role="alert" className="text-sm">Unable to load duplicate candidates.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void candidates.refetch()}>Retry candidates</Button></div>
            : candidates.data?.data.length === 0 ? <p className="text-sm text-muted-foreground">No matching approved findings on this asset.</p>
              : candidates.data?.data.map(row => <Label key={row.id} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
                <input type="radio" name={`${field}-target`} value={row.id} checked={target === row.id} onChange={() => setTarget(row.id)} className="mt-1 shrink-0" />
                <span className="min-w-0 space-y-1"><span className="block break-words text-sm">{row.name}</span>
                  <span className="flex flex-wrap items-center gap-2"><SeverityBadge severity={row.severity} /><span className="text-xs text-muted-foreground">Matches: {row.reasons.join(', ')}</span></span>
                </span></Label>)}
        </fieldset>}
        {write.error && <p role="alert" className="text-sm text-destructive">{write.error}</p>}
        <DialogFooter className="flex-wrap gap-2">
          {write.uncertain && <><Button type="button" variant="outline" disabled={write.busy} onClick={() => void write.checkSaved(reload)}>Check saved state</Button>
            {write.reviewed && <Button type="button" variant="outline" disabled={write.busy} onClick={write.discard}>Discard local attempt</Button>}</>}
          <Button type="button" variant="outline" disabled={write.busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={write.busy || write.uncertain || invalid}>{write.busy ? 'Saving…' : title}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ReviewDialog(props: Props) {
  const { selectedWorkspace } = useWorkspaceSelector();
  return selectedWorkspace ? <ScopedReview key={`${selectedWorkspace}:${props.mode}:${props.ids.join(',')}`} workspaceId={selectedWorkspace} {...props} /> : null;
}
