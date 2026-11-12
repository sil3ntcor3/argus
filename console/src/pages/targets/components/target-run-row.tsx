import JobStatusBadge from '@/components/ui/job-status';
import { JobStatus, type TargetRunDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import type { RefObject } from 'react';
import { TargetRunCancel } from './target-run-cancel';

const runDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Displays a run and its target-specific progress. */
export function TargetRunRow({
  run,
  canReadProjects,
  canReadFindings,
  canCancelRuns,
  focusAfterCancel,
}: {
  run: TargetRunDto;
  canReadProjects: boolean;
  canReadFindings: boolean;
  canCancelRuns: boolean;
  focusAfterCancel: RefObject<HTMLElement | null>;
}) {
  const name = run.workflowName.trim() || 'Workflow run';
  const started = runDate.format(new Date(run.createdAt));
  const trigger =
    run.jobRunType === 'scheduled'
      ? 'Scheduled'
      : run.jobRunType === 'event'
        ? 'Event'
        : 'Manual';
  const newFindings = canReadFindings ? (run.newVulnerabilities ?? 0) : 0;
  const canCancel =
    canCancelRuns &&
    run.isCompleted === false &&
    (run.status === JobStatus.pending || run.status === JobStatus.in_progress);
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
      {canReadProjects && run.projectId && run.projectName && (
        <p className="text-xs break-words text-muted-foreground">
          Project{' '}
          <Link
            to="/projects/$id"
            params={{ id: run.projectId }}
            className="rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {run.projectName}
          </Link>
        </p>
      )}
      <p className="text-xs text-muted-foreground tabular-nums">
        {run.jobsDone} done · {run.jobsFailed} failed · {run.jobsRunning}{' '}
        running · {run.jobsTotal} total
      </p>
      {run.currentTool && (
        <p className="text-xs break-words text-muted-foreground">
          Running tool {run.currentTool}
        </p>
      )}
      {newFindings > 0 && (
        <p className="text-xs font-medium text-primary">
          {newFindings} new {newFindings === 1 ? 'finding' : 'findings'}
        </p>
      )}
      {canCancel && (
        <TargetRunCancel
          runId={run.id}
          name={name}
          focusAfterCancel={focusAfterCancel}
        />
      )}
    </li>
  );
}
