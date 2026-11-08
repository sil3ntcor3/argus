import Page from '@/components/common/page';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import CreateWorkspace from '../workspaces/create-workspace';
import { FastScanDialog } from './components/fast-scan-dialog';
import { VulnerabilitiesView } from './vulnerabilities-view';

const Vulnerabilities = () => {
  const { workspaces } = useWorkspaceSelector();
  return (
    <Page
      title="Vulnerabilities"
      description="Security findings from scans across your assets"
      permission="vulnerability.read"
    >
      {workspaces.length === 0 ? (
        <CreateWorkspace />
      ) : (
        <VulnerabilitiesView actions={<FastScanDialog />} />
      )}
    </Page>
  );
};

export default Vulnerabilities;
