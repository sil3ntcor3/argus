import Page from '@/components/common/page';
import { TargetsSummary } from './components/targets-summary';
import { ListTargets } from './list-targets';

const Targets = () => {
  return (
    <Page
      title="Targets"
      description="Domains, IP ranges and repositories in your scanning scope"
      permission="target.read"
    >
      <div className="space-y-4">
        <TargetsSummary />
        <ListTargets />
      </div>
    </Page>
  );
};

export default Targets;
