import JobStatusBadge from '@/components/ui/job-status';
import type { TargetRunDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

const runDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Displays a run and its target-specific progress. */
export function TargetRunRow({ run }: { run: TargetRunDto }) {
  const name = run.workflowName.trim() || 'Workflow run';
  const started = runDate.format(new Date(run.createdAt));
  const trigger = run.jobRunType === 'scheduled' ? 'Scheduled' : 'Manual';
  return (
    <li className="space-y-1 p-3 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <Link
          to="/jobs/runs/$id"
          params={{ id: run.id }}
          aria-label={`${name}, ${trigger}, ${started}, ${run.id.slice(0, 8)}`}
          className="min-w-0 rounded-sm text-sm font-medium break-words text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {name}
        </Link>
        <JobStatusBadge status={run.status} />
      </div>
      <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{trigger}</span>
        <time dateTime={run.createdAt}>{started}</time>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {run.jobsDone} done · {run.jobsFailed} failed · {run.jobsRunning}{' '}
        running · {run.jobsTotal} total
      </p>
    </li>
  );
}
