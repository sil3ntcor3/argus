import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { vulnerabilitiesControllerClaimFix, type ClaimFixDto } from '@/services/apis/gen/queries';
import { useFindingWrite } from '../use-finding-write';

type Props = { vulnerabilityIds: string[]; trigger: ReactNode; onSuccess?: () => void; reload: () => Promise<unknown> };
function ScopedClaim({ workspaceId, vulnerabilityIds, trigger, onSuccess, reload }: Props & { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const permission = usePermission();
  const canWrite = !permission.isLoading && !permission.error && permission.hasPermission('vulnerability.write');
  const ids = [...new Set(vulnerabilityIds)].sort();
  const write = useFindingWrite({ workspaceId, operation: `claim:${ids.join(',')}`, canWrite,
    perform: (data: ClaimFixDto, request) => vulnerabilitiesControllerClaimFix(data, request),
    onSuccess: result => { toast.success(`Fix claimed for ${result.updated} finding(s)`); setOpen(false); setNote(''); onSuccess?.(); } });
  if (!canWrite) return null;
  return <Dialog open={open} onOpenChange={next => { if (!write.busy) { setOpen(next); if (!next) setNote(''); } }}>
    <DialogTrigger asChild>{trigger}</DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
      <DialogHeader><DialogTitle>Mark fixed</DialogTitle><DialogDescription>
        Record a fix claim for {ids.length} finding(s). They stay open until trusted covering scans confirm the fix under workspace policy. This does not start a scan.
      </DialogDescription></DialogHeader>
      <div className="space-y-2"><Label htmlFor="claim-fix-note">What changed (optional)</Label>
        <Textarea id="claim-fix-note" value={note} maxLength={5000} rows={3} disabled={write.busy || write.uncertain}
          onChange={event => setNote(event.target.value)} /></div>
      {write.error && <p role="alert" className="text-sm text-destructive">{write.error}</p>}
      <DialogFooter>
        {write.uncertain && <Button variant="outline" disabled={write.busy} onClick={() => void write.checkSaved(reload)}>Check saved state</Button>}
        <Button variant="outline" disabled={write.busy} onClick={() => setOpen(false)}>Cancel</Button>
        <Button disabled={write.busy || write.uncertain || !ids.length || ids.length > 1000 || note.length > 5000}
          onClick={() => void write.run({ vulnerabilityIds: ids, ...(note.trim() ? { note: note.trim() } : {}) })}>
          {write.busy ? 'Saving…' : 'Mark fixed'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
export function ClaimFixDialog(props: Props) {
  const { selectedWorkspace } = useWorkspaceSelector();
  return selectedWorkspace ? <ScopedClaim key={`${selectedWorkspace}:${props.vulnerabilityIds.join(',')}`} workspaceId={selectedWorkspace} {...props} /> : null;
}
