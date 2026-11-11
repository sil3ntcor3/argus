import JobStatusBadge from '@/components/ui/job-status';
import type { ProjectOverviewRunRefDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

const runDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Shows a project-safe run reference and links only with job read access. */
function RunReference({
  run,
  canOpen,
}: {
  run: ProjectOverviewRunRefDto;
  canOpen: boolean;
}) {
  const name = run.workflowName.trim() || 'Workflow run';
  const trigger = run.jobRunType === 'scheduled' ? 'Scheduled' : 'Manual';
  const started = runDate.format(new Date(run.createdAt));
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        {canOpen ? (
          <Link
            to="/jobs/runs/$id"
            params={{ id: run.id }}
            aria-label={`${name}, ${trigger}, ${started}`}
            className="rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {name}
          </Link>
        ) : (
          <p className="text-sm font-medium">{name}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{trigger}</span>
          <time dateTime={run.createdAt}>{started}</time>
        </div>
      </div>
      <JobStatusBadge status={run.status} />
    </div>
  );
}

/** Separates the last run from the runs that first recorded new findings. */
export function ProjectOverviewRuns({
  lastRun,
  discoveryRuns,
  canOpenRuns,
}: {
  lastRun: ProjectOverviewRunRefDto | null;
  discoveryRuns: ProjectOverviewRunRefDto[];
  canOpenRuns: boolean;
}) {
  const card =
    'min-w-0 space-y-3 rounded-xl border bg-card p-4 text-card-foreground';
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section aria-labelledby="project-latest-run-heading" className={card}>
        <h2 id="project-latest-run-heading" className="text-base font-semibold">
          Latest run
        </h2>
        {lastRun ? (
          <RunReference run={lastRun} canOpen={canOpenRuns} />
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
      </section>
      <section
        aria-labelledby="project-discovery-runs-heading"
        className={card}
      >
        <h2
          id="project-discovery-runs-heading"
          className="text-base font-semibold"
        >
          Runs with new findings
        </h2>
        {discoveryRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs with new findings in the last seven days.
          </p>
        ) : (
          <ul className="divide-y">
            {discoveryRuns.map((run) => (
              <li key={run.id} className="py-2 first:pt-0 last:pb-0">
                <RunReference run={run} canOpen={canOpenRuns} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
