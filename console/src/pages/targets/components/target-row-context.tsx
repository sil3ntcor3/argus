import { Badge } from '@/components/ui/badge';
import type { GetManyTargetResponseDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** Distinguishes an authorized zero from a redacted or unavailable count. */
export function TargetRowFindings({
  counts,
}: {
  counts: GetManyTargetResponseDto['openVulnerabilities'];
}) {
  if (counts == null) return <span className="text-muted-foreground">—</span>;
  const positive = severities.filter((severity) => counts[severity] > 0);
  return positive.length ? (
    <div className="flex max-w-52 flex-wrap gap-1">
      {positive.map((severity) => (
        <Badge key={severity} variant="outline">
          {counts[severity]} {severity}
        </Badge>
      ))}
    </div>
  ) : (
    <span className="text-muted-foreground">No open findings</span>
  );
}

/** Settled includes failures and cancellations; it is not a success rate. */
export function TargetRowProgress({
  progress,
}: {
  progress: GetManyTargetResponseDto['scanProgress'];
}) {
  if (!progress || progress.total <= 0) return null;
  const done = Math.min(progress.total, Math.max(0, progress.done));
  return (
    <div className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
      <progress
        aria-label="Target scan progress"
        aria-valuemin={0}
        aria-valuenow={done}
        aria-valuemax={progress.total}
        value={done}
        max={progress.total}
        className="h-1.5 w-28 accent-primary"
      />
      <span>
        {done}/{progress.total} jobs settled
      </span>
    </div>
  );
}

/** Only a recorded, valid scheduler instant is shown as a next scan. */
export function TargetRowNextScan({
  at,
}: {
  at: GetManyTargetResponseDto['nextScanAt'];
}) {
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) ? (
    <time
      dateTime={date.toISOString()}
      className="text-xs text-muted-foreground"
    >
      Next scan {dateFormat.format(date)}
    </time>
  ) : null;
}

/** Project navigation stays independent from the table row's target navigation. */
export function TargetRowProjects({
  projects,
}: {
  projects: GetManyTargetResponseDto['projects'];
}) {
  if (projects == null) return <span className="text-muted-foreground">—</span>;
  return projects.length ? (
    <ul className="flex max-w-56 flex-wrap gap-1">
      {projects.map((project) => (
        <li key={project.id} className="min-w-0">
          <Link
            to="/projects/$id"
            params={{ id: project.id }}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex max-w-full items-center gap-1 rounded border px-2 py-1 text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {project.hexColor && /^#[\da-f]{6}$/i.test(project.hexColor) && (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: project.hexColor }}
              />
            )}
            <span className="min-w-0 break-words">{project.name}</span>
            <span className="shrink-0 text-muted-foreground">
              {' '}
              · {project.assets}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  ) : (
    <span className="text-muted-foreground">No projects</span>
  );
}
