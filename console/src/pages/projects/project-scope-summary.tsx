import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type ProjectScopeRuleType,
  type ScopeRuleDto,
  useProjectsControllerGetScopeRules,
} from '@/services/apis/gen/queries';
import { isAxiosError } from 'axios';
import { type ReactNode, useId, useRef, useState } from 'react';
import { ProjectScopePreview } from './project-scope-preview';

const count = new Intl.NumberFormat();
const ruleLabels = {
  asset: 'Asset',
  target: 'Target',
  hostname: 'Hostname',
  cidr: 'CIDR',
} satisfies Record<ProjectScopeRuleType, string>;

const rulesPerPage = 20;

function ScopeRuleList({ rules }: { rules: ScopeRuleDto[] }) {
  const [selectedPage, setPage] = useState(1);
  const pageCount = Math.ceil(rules.length / rulesPerPage);
  const page = Math.min(selectedPage, pageCount);
  const visibleRules = rules.slice(
    (page - 1) * rulesPerPage,
    page * rulesPerPage,
  );
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer font-medium">
        Scope rules ({count.format(rules.length)})
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">
        Rule counts can overlap. Include counts are measured before exclusions.
      </p>
      <ul aria-label="Saved scope rules" className="mt-2 divide-y">
        {visibleRules.map((rule) => (
          <li
            key={rule.id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm"
          >
            <Badge variant="outline">
              {rule.mode === 'include' ? 'Include' : 'Exclude'}
            </Badge>
            <span>{ruleLabels[rule.type]}</span>
            <span className="font-medium">{rule.label || rule.value}</span>
            <span className="text-muted-foreground">
              {count.format(rule.matched)}{' '}
              {rule.mode === 'include'
                ? 'matched'
                : 'excluded from rule matches'}
            </span>
          </li>
        ))}
      </ul>
      {pageCount > 1 && (
        <nav
          aria-label="Scope rule pages"
          className="flex flex-wrap items-center gap-3 pt-2"
        >
          <Button
            variant="outline"
            size="sm"
            aria-disabled={page === 1}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (page > 1) setPage(page - 1);
            }}
          >
            Previous rules
          </Button>
          <span aria-live="polite">
            Page {count.format(page)} of {count.format(pageCount)}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-disabled={page === pageCount}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (page < pageCount) setPage(page + 1);
            }}
          >
            Next rules
          </Button>
        </nav>
      )}
    </details>
  );
}

/** Shows the saved membership policy and rule evidence for the selected project. */
export function ProjectScopeSummary({ projectId }: { projectId: string }) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { data, error, isError, isFetching, refetch } =
    useProjectsControllerGetScopeRules(projectId, { query: { retry: false } });
  const status = isAxiosError(error) ? error.response?.status : undefined;
  let content: ReactNode;
  if (status === 403 || status === 404) {
    content = <p role="status">Project scope unavailable</p>;
  } else if (isError) {
    content = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load project scope</p>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => {
            heading.current?.focus();
            void refetch();
          }}
        >
          Retry scope
        </Button>
      </div>
    );
  } else if (!data) {
    content = (
      <Skeleton
        role="status"
        aria-label="Loading project scope"
        className="h-16 rounded-md"
      />
    );
  } else {
    content = (
      <>
        <p className="text-sm text-muted-foreground">
          Automatic additions for newly discovered matches are{' '}
          {data.autoAddAssets ? 'on' : 'off'}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Saved project members</span>
          <Badge variant="secondary">
            {count.format(data.manualAssets)} manual
          </Badge>
          <Badge variant="secondary">
            {count.format(data.ruleAssets)} from rules
          </Badge>
        </div>
        <ProjectScopePreview
          key={projectId}
          projectId={projectId}
          rules={data.rules}
        />
        {data.rules.length ? (
          <ScopeRuleList key={projectId} rules={data.rules} />
        ) : (
          <p className="text-sm text-muted-foreground">No saved scope rules</p>
        )}
      </>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="font-medium focus-visible:outline-ring"
      >
        Project scope
      </h2>
      {content}
    </section>
  );
}
