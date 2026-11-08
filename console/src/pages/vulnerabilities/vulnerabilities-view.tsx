import { useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ListVulnerabilities } from './list-vulnerabilitys';
import VulnerabilitiesStatistic from './vulnerabilites-statistic';

/** Shares the findings list and severity summary across workspace and target views. */
export function VulnerabilitiesView({
  targetId,
  actions,
}: {
  targetId?: string;
  actions?: ReactNode;
}) {
  const search = useSearch({ strict: false });
  const searchTarget = 'targetId' in search ? search.targetId : undefined;
  const scope =
    targetId || (typeof searchTarget === 'string' ? searchTarget : undefined);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <VulnerabilitiesStatistic targetId={scope} />
      <ListVulnerabilities targetId={scope} actions={actions} />
    </div>
  );
}
