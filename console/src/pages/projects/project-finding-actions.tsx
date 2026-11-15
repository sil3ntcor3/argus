import { useState } from 'react';
import { addDays, format } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { isOpenFinding } from '@/components/vulnerabilities/lifecycle';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { ClaimFixDialog } from '@/pages/vulnerabilities/components/claim-fix-dialog';
import { ReviewDialog } from '@/pages/vulnerabilities/components/review-dialog';
import { FindingBulkActions } from '@/pages/vulnerabilities/components/finding-bulk-actions';
import {
  latestRiskExpiry,
  riskExpiryAt,
} from '@/pages/vulnerabilities/risk-expiry';
import { useFindingWrite } from '@/pages/vulnerabilities/use-finding-write';
import {
  vulnerabilitiesControllerBulkDismissVulnerabilities,
  useVulnerabilitiesControllerGetSettings,
  type BulkDismissVulnerabilitiesDto,
  type ProjectFindingDto,
} from '@/services/apis/gen/queries';

type Props = {
  findings: ProjectFindingDto[];
  reload: () => Promise<unknown>;
  onDone: () => void;
};
const reasons = {
  false_positive: 'False positive',
  used_in_test: 'Used in tests',
  wont_fix: 'Won’t fix',
  risk_accepted: 'Risk accepted',
} as const;

/** Reuse the existing dismissal API with workspace/unknown-outcome guards. */
function ProjectDismiss({
  workspaceId,
  ids,
  reload,
  onDone,
}: Omit<Props, 'findings'> & { workspaceId: string; ids: string[] }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<keyof typeof reasons | ''>('');
  const [comment, setComment] = useState('');
  const [expiry, setExpiry] = useState('');
  const permission = usePermission();
  const canWrite =
    !permission.isLoading &&
    !permission.isFetching &&
    !permission.error &&
    permission.hasPermission('vulnerability.write');
  const policy = useVulnerabilitiesControllerGetSettings({
    query: {
      enabled: open && reason === 'risk_accepted',
      retry: false,
      refetchOnMount: 'always',
    },
  });
  const ready =
    !!policy.data &&
    policy.isFetchedAfterMount &&
    !policy.isError &&
    !policy.isFetching;
  const maxDays = policy.data?.riskAcceptMaxDays ?? 180;
  const expiresAt =
    reason === 'risk_accepted'
      ? riskExpiryAt(expiry, new Date(), maxDays)
      : null;
  const reset = () => {
    setReason('');
    setComment('');
    setExpiry('');
  };
  const write = useFindingWrite({
    workspaceId,
    operation: `project-dismiss:${ids.join(',')}`,
    canWrite,
    perform: (data: BulkDismissVulnerabilitiesDto, request) =>
      vulnerabilitiesControllerBulkDismissVulnerabilities(data, request),
    onSuccess: () => {
      toast.success('Selected alerts dismissed');
      setOpen(false);
      reset();
      onDone();
    },
  });
  const invalid =
    !reason ||
    !ids.length ||
    ids.length > 1000 ||
    comment.length > 5000 ||
    (reason === 'risk_accepted' && (!ready || !expiresAt));
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!write.busy) {
          setOpen(next);
          if (!next && !write.uncertain) reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Dismiss alerts
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid && reason)
              void write.run({
                ids,
                reason,
                comment: comment.trim(),
                ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>Dismiss alerts</DialogTitle>
            <DialogDescription>
              Dismiss {ids.length} selected open finding(s). Risk acceptance
              ends on the selected date.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm">
            Reason
            <select
              aria-label="Reason"
              className="h-9 rounded-md border bg-background px-2"
              value={reason}
              disabled={write.busy || write.uncertain}
              onChange={(event) => {
                setReason(event.target.value as typeof reason);
                setExpiry('');
              }}
            >
              <option value="">Select a reason</option>
              {Object.entries(reasons).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {reason === 'risk_accepted' && (
            <div className="space-y-2">
              <label className="grid gap-2 text-sm">
                Accepted until
                <Input
                  type="date"
                  required
                  value={expiry}
                  disabled={write.busy || write.uncertain}
                  min={format(addDays(new Date(), 1), 'yyyy-MM-dd')}
                  max={format(
                    latestRiskExpiry(new Date(), maxDays),
                    'yyyy-MM-dd',
                  )}
                  onChange={(event) => setExpiry(event.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Choose a future date within {maxDays} days. Acceptance ends at
                local midnight.
              </p>
              {!ready &&
                (policy.isError ? (
                  <div>
                    <p role="alert">Unable to load risk acceptance policy</p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={policy.isFetching}
                      onClick={() => void policy.refetch()}
                    >
                      Retry policy
                    </Button>
                  </div>
                ) : (
                  <p role="status">Loading risk acceptance policy…</p>
                ))}
            </div>
          )}
          <label className="grid gap-2 text-sm">
            Comment (optional)
            <Textarea
              rows={3}
              maxLength={5000}
              value={comment}
              disabled={write.busy || write.uncertain}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          {write.error && (
            <p role="alert" className="text-sm text-destructive">
              {write.error}
            </p>
          )}
          <DialogFooter>
            {write.uncertain && (
              <Button
                type="button"
                variant="outline"
                disabled={write.busy}
                onClick={() => void write.checkSaved(reload)}
              >
                Check saved state
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={write.busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canWrite || invalid || write.busy || write.uncertain}
            >
              {write.busy ? 'Saving…' : 'Dismiss'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Keep proposal reviews separate; issue creation does not require finding-write access. */
export function ProjectFindingActions({
  findings: input,
  reload,
  onDone,
}: Props) {
  const permission = usePermission();
  const { selectedWorkspace } = useWorkspaceSelector();
  const findings = [
    ...new Map(input.map((row) => [row.id, row])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const canWrite = permission.hasPermission('vulnerability.write');
  if (
    !selectedWorkspace ||
    permission.isLoading ||
    permission.isFetching ||
    permission.error ||
    !findings.length
  )
    return null;
  const pending = findings.filter(
    (row) => row.reviewStatus === 'pending_review',
  );
  const approved = findings.every((row) => row.reviewStatus === 'approved');
  const open = approved ? findings.filter(isOpenFinding) : [];
  const unclaimed = open.filter((row) => !row.fixClaimedAt);
  const scope = `${selectedWorkspace}:${findings.map((row) => row.id).join(',')}`;
  return (
    <div
      key={scope}
      className="flex flex-wrap items-center gap-2"
      aria-label="Selected project finding actions"
    >
      {canWrite &&
        pending.length === findings.length &&
        (['approve', 'reject'] as const).map((mode) => (
          <ReviewDialog
            key={mode}
            ids={pending.map((row) => row.id)}
            mode={mode}
            reload={reload}
            onSuccess={onDone}
            trigger={
              <Button size="sm" variant="outline">
                {mode === 'approve' ? 'Approve proposals' : 'Reject proposals'}
              </Button>
            }
          />
        ))}
      {canWrite && unclaimed.length > 0 && (
        <ClaimFixDialog
          vulnerabilityIds={unclaimed.map((row) => row.id)}
          reload={reload}
          onSuccess={onDone}
          trigger={
            <Button size="sm" variant="outline">
              Mark fixed
            </Button>
          }
        />
      )}
      {canWrite && open.length > 0 && (
        <ProjectDismiss
          key={`${scope}:${open.map((row) => row.id).join(',')}`}
          workspaceId={selectedWorkspace}
          ids={open.map((row) => row.id)}
          reload={reload}
          onDone={onDone}
        />
      )}
      {approved && (
        <FindingBulkActions
          findings={findings}
          reload={reload}
          onDone={onDone}
        />
      )}
    </div>
  );
}
