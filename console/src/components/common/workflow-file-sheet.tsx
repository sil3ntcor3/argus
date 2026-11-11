import { CodeBlock } from '@/components/common/code-block';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Code2 } from 'lucide-react';
import { stringify } from 'yaml';

const TOP_KEYS = ['name', 'on', 'jobs'];
const JOB_KEYS = [
  'name',
  'run',
  'category',
  'input',
  'needs',
  'allowFailure',
  'configProfileId',
  'config',
];

type Entries = Record<string, unknown>;

/** `value` with `first` keys in that order, then the others as they come. */
function withKeyOrder(value: Entries, first: string[]): Map<string, unknown> {
  const keys = [
    ...first.filter((key) => Object.hasOwn(value, key)),
    ...Object.keys(value).filter((key) => !first.includes(key)),
  ];
  return new Map(keys.map((key) => [key, value[key]] as const));
}

/** Jobs in run order: a job comes after every job it needs. */
function jobsInRunOrder(jobs: Entries): Map<string, unknown> {
  const needsOf = (id: string): string[] => {
    const needs = (jobs[id] as { needs?: unknown } | null)?.needs;
    return (Array.isArray(needs) ? needs : needs ? [needs] : []).map(String);
  };
  const ordered: string[] = [];
  const visit = (id: string, path: string[]) => {
    if (ordered.includes(id) || path.includes(id) || !Object.hasOwn(jobs, id))
      return;
    needsOf(id).forEach((need) => visit(need, [...path, id]));
    ordered.push(id);
  };
  Object.keys(jobs).forEach((id) => visit(id, []));
  return new Map(
    ordered.map((id): [string, unknown] => {
      const job = jobs[id];
      return [
        id,
        job && typeof job === 'object' && !Array.isArray(job)
          ? withKeyOrder(job as Entries, JOB_KEYS)
          : job,
      ];
    }),
  );
}

/**
 * A workflow definition as YAML, the way it reads as a file: `name`, `on`,
 * then the jobs in run order. Stored definitions are Postgres jsonb, which
 * does not keep key order, so the order is set here. Default block style:
 * `collectionStyle: 'flow'` would flatten it into one JSON-looking line.
 * Empty for a missing definition.
 */
export function workflowYaml(content: object | null | undefined): string {
  if (!content) return '';
  const top = withKeyOrder(content as Entries, TOP_KEYS);
  const jobs = top.get('jobs');
  if (jobs && typeof jobs === 'object' && !Array.isArray(jobs)) {
    top.set('jobs', jobsInRunOrder(jobs as Entries));
  }
  return stringify(top);
}

/**
 * "View workflow" button and the side sheet showing a workflow as its file.
 * Used by a run's page and by a group's workflows.
 */
export function WorkflowFileSheet({
  yaml,
  description,
  triggerLabel,
  open,
  onOpenChange,
  isLoading = false,
  emptyMessage = 'No workflow attached.',
}: {
  yaml: string;
  description: string;
  triggerLabel?: string;
  /** Controlled open state, e.g. to fetch the definition only when opened. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isLoading?: boolean;
  emptyMessage?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={triggerLabel}>
          <Code2 className="size-4" />
          View workflow
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto sm:max-w-2xl"
      >
        <SheetHeader>
          <SheetTitle>Workflow definition</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : yaml ? (
            <CodeBlock language="yaml" showLine value={yaml} />
          ) : (
            <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
