import { useState } from 'react';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { useVulnerabilitiesControllerGetSettings, vulnerabilitiesControllerUpdateSettings,
  type VulnerabilitySettingsDto, type UpdateVulnerabilitySettingsDto } from '@/services/apis/gen/queries';
import { useFindingWrite } from '../use-finding-write';

import { severities, validFindingPolicy, findingPolicyChanges } from "../finding-policy";

function PolicyForm({ workspaceId, canWrite, onSaved }: { workspaceId: string; canWrite: boolean; onSaved: () => void }) {
  const query = useVulnerabilitiesControllerGetSettings({ query: {
    queryKey: ['/api/vulnerabilities/settings', workspaceId], retry: false,
    refetchOnMount: 'always', gcTime: 0,
  } });
  const [draft, setDraft] = useState<{ base: VulnerabilitySettingsDto; value: VulnerabilitySettingsDto }>();
  const write = useFindingWrite({ workspaceId, operation: 'policy', canWrite,
    perform: (data: UpdateVulnerabilitySettingsDto, request) => vulnerabilitiesControllerUpdateSettings(data, request), onSuccess: onSaved });
  const loadSaved = async () => {
    const result = await query.refetch();
    if (result.isError || !result.data) throw new Error('Policy unavailable');
    setDraft(undefined);
  };
  if (query.isError) return <div className="space-y-3"><p role="alert">Unable to load finding settings.</p>
    <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry settings</Button></div>;
  if (!query.data || !query.isFetchedAfterMount) return <p role="status">Loading finding settings…</p>;
  const value = draft?.value ?? query.data;
  const changes = findingPolicyChanges(draft?.base ?? query.data, value);
  const disabled = write.busy || write.uncertain || query.isFetching || !canWrite;
  const update = (next: Partial<VulnerabilitySettingsDto>) => setDraft({ base: draft?.base ?? query.data, value: { ...value, ...next } });
  return <form className="space-y-5" onSubmit={event => { event.preventDefault();
    if (!disabled && validFindingPolicy(value) && Object.keys(changes).length) void write.run(changes);
  }}>
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-medium">Remediation SLA</legend>
      <p className="text-sm text-muted-foreground">Days from discovery or resurfacing. Leave a severity blank for no SLA.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{severities.map(key => <div key={key} className="space-y-1">
        <Label htmlFor={`sla-${key}`} className="capitalize">{key} days</Label>
        <Input id={`sla-${key}`} type="number" min={1} max={3650} step={1} placeholder="No SLA"
          value={value.slaDays[key] ?? ''} onChange={event => update({ slaDays: { ...value.slaDays,
            [key]: event.target.value === '' ? null : event.target.valueAsNumber } })} />
      </div>)}</div>
      <Label className="flex items-center gap-2"><input type="checkbox" checked={value.slaRestartOnResurface}
        onChange={event => update({ slaRestartOnResurface: event.target.checked })} />Restart SLA when a finding resurfaces</Label>
    </fieldset>
    <fieldset disabled={disabled} className="space-y-3 border-t pt-4">
      <legend className="text-sm font-medium">Scan verification</legend>
      <Label className="flex items-center gap-2"><input type="checkbox" checked={value.autoCloseEnabled}
        onChange={event => update({ autoCloseEnabled: event.target.checked })} />Automatically close findings missing from trusted covering scans</Label>
      <div className="space-y-1"><Label htmlFor="missed-scans">Missed covering runs before closure</Label>
        <Input id="missed-scans" type="number" min={1} max={10} step={1} required value={Number.isFinite(value.autoCloseMissedScans) ? value.autoCloseMissedScans : ''}
          onChange={event => update({ autoCloseMissedScans: event.target.valueAsNumber })} /></div>
      <p className="text-sm text-muted-foreground">Only complete scans with the same asset, tool, configuration and connector image can confirm a fix. Partial or cancelled scans cannot close findings.</p>
    </fieldset>
    <fieldset disabled={disabled} className="space-y-1 border-t pt-4">
      <Label htmlFor="risk-max">Maximum risk acceptance (days)</Label>
      <Input id="risk-max" type="number" min={1} max={3650} step={1} required value={Number.isFinite(value.riskAcceptMaxDays) ? value.riskAcceptMaxDays : ''}
        onChange={event => update({ riskAcceptMaxDays: event.target.valueAsNumber })} />
      <p className="text-sm text-muted-foreground">Applies to new acceptances. Existing expiry dates stay in place.</p>
    </fieldset>
    {write.error && <p role="alert" className="text-sm text-destructive">{write.error}</p>}
    <DialogFooter>
      <Button type="button" variant="outline" disabled={write.busy} onClick={() => void write.checkSaved(loadSaved)}>Check saved state</Button>
      <Button type="submit" disabled={disabled || !validFindingPolicy(value) || !Object.keys(changes).length}>{write.busy ? 'Saving…' : 'Save settings'}</Button>
    </DialogFooter>
  </form>;
}

function SettingsDialog({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const permission = usePermission();
  const canWrite = !permission.isLoading && !permission.error && permission.hasPermission('workspace.config');
  if (!canWrite) return null;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" size="sm"><Settings className="size-4" />Finding settings</Button></DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>Finding settings</DialogTitle><DialogDescription>Workspace remediation deadlines, verification and risk acceptance.</DialogDescription></DialogHeader>
      {open && <PolicyForm workspaceId={workspaceId} canWrite={canWrite} onSaved={() => setOpen(false)} />}
    </DialogContent>
  </Dialog>;
}

export function FindingSettings() {
  const { selectedWorkspace } = useWorkspaceSelector();
  return selectedWorkspace ? <SettingsDialog key={selectedWorkspace} workspaceId={selectedWorkspace} /> : null;
}
