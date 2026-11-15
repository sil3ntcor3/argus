import { Button } from '@/components/ui/button';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { CreateIssueDialog } from '@/pages/issues/components/create-issue-dialog';
import { IssueBoundary } from '@/pages/issues/issue-api';
import {
  vulnerabilitiesControllerBulkReopenVulnerabilities,
  type VulnerabilityLifecycleDto,
} from '@/services/apis/gen/queries';
import { BellRing, ClipboardList } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useFindingWrite } from '../use-finding-write';

type Props = {
  findings: VulnerabilityLifecycleDto[];
  reload: () => Promise<unknown>;
  onDone: () => void;
};

/** Keep drafts and pending writes tied to visible finding IDs and workspace access. */
function ScopedActions({
  workspaceId,
  findings,
  reload,
  onDone,
  canReopen,
  canCreate,
  refreshing,
}: Props & {
  workspaceId: string;
  canReopen: boolean;
  canCreate: boolean;
  refreshing: boolean;
}) {
  const [issueOpen, setIssueOpen] = useState(false);
  const dismissed = findings.flatMap((finding) =>
    finding.vulnerabilityDismissal?.id
      ? [finding.vulnerabilityDismissal.id]
      : [],
  );
  const write = useFindingWrite({
    workspaceId,
    operation: 'bulk-reopen',
    canWrite: canReopen && !refreshing,
    perform: (ids: string[], options) =>
      vulnerabilitiesControllerBulkReopenVulnerabilities({ ids }, options),
    onSuccess: () => {
      toast.success('Selected alerts reopened');
      onDone();
    },
  });
  return (
    <>
      {canReopen && dismissed.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing || write.busy || write.uncertain}
          onClick={() => void write.run(dismissed)}
        >
          <BellRing data-icon="inline-start" />
          Reopen
        </Button>
      )}
      {write.error && (
        <p role="alert" className="text-sm text-destructive">
          {write.error}
        </p>
      )}
      {write.uncertain && (
        <Button
          variant="outline"
          size="sm"
          disabled={write.busy || refreshing}
          onClick={() => void write.checkSaved(reload)}
        >
          Check saved state
        </Button>
      )}
      {canCreate && (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => setIssueOpen(true)}
          >
            <ClipboardList data-icon="inline-start" />
            Create issue
          </Button>
          <IssueBoundary>
            <CreateIssueDialog
              open={issueOpen}
              onOpenChange={setIssueOpen}
              defaultType="vulnerability_remediation"
              defaultTitle={
                findings.length === 1
                  ? findings[0].name
                  : `Remediate ${findings.length} findings`
              }
              linkSummary={`${findings.length} selected ${findings.length === 1 ? 'finding' : 'findings'} will be linked to this remediation issue.`}
              links={findings.map((finding) => ({
                resourceType: 'vulnerability',
                resourceId: finding.id,
              }))}
            />
          </IssueBoundary>
        </>
      )}
    </>
  );
}

/** Reuse the approved finding/issue APIs without mixing proposal and remediation selections. */
export function FindingBulkActions(props: Props) {
  const permission = usePermission();
  const { selectedWorkspace } = useWorkspaceSelector();
  const findings = [
    ...new Map(props.findings.map((finding) => [finding.id, finding])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const canReopen = permission.hasPermission('vulnerability.write');
  const canCreate =
    permission.hasPermission('workspace.write') &&
    permission.hasPermission('workspace.read');
  if (
    !selectedWorkspace ||
    permission.isLoading ||
    permission.error ||
    !findings.length ||
    findings.some(
      (finding) => finding.reviewStatus && finding.reviewStatus !== 'approved',
    ) ||
    (!canReopen && !canCreate)
  )
    return null;
  return (
    <ScopedActions
      key={`${selectedWorkspace}:${canReopen}:${canCreate}:${findings.map((finding) => finding.id).join(',')}`}
      {...props}
      findings={findings}
      workspaceId={selectedWorkspace}
      canReopen={canReopen}
      canCreate={canCreate}
      refreshing={permission.isFetching}
    />
  );
}
