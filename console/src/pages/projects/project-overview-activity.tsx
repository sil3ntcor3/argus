import JobStatusBadge from '@/components/ui/job-status';
import type {
  ProjectOverviewActivityDto,
  ProjectOverviewActivityDtoChange,
  ProjectOverviewActivityDtoReason,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

const auditTitles = new Map([
  ['project.created', 'Project created'],
  ['project.archived', 'Project archived'],
  ['project.unarchived', 'Project reopened'],
]);
const changeTitles: Record<ProjectOverviewActivityDtoChange, string> = {
  settings: 'Project settings changed',
  'assets.added': 'Assets added',
  'assets.discovered': 'Assets discovered',
  'assets.removed': 'Assets removed',
  scope: 'Scope rules changed',
  'workflow.added': 'Workflow added',
  'workflow.updated': 'Workflow changed',
  'workflow.removed': 'Workflow removed',
  triggers: 'Workflow triggers changed',
};
const changeDestinations = new Map<
  ProjectOverviewActivityDtoChange,
  '/projects/$id/assets' | '/projects/$id/workflows'
>([
  ['assets.added', '/projects/$id/assets'],
  ['assets.discovered', '/projects/$id/assets'],
  ['assets.removed', '/projects/$id/assets'],
  ['scope', '/projects/$id/assets'],
  ['workflow.added', '/projects/$id/workflows'],
  ['workflow.updated', '/projects/$id/workflows'],
  ['workflow.removed', '/projects/$id/workflows'],
]);
const dismissalLabels: Record<ProjectOverviewActivityDtoReason, string> = {
  false_positive: 'False positive',
  used_in_test: 'Used in test',
  wont_fix: 'Won’t fix',
};
const eventDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const count = new Intl.NumberFormat();

/** Formats optional run totals without implying that missing data is zero. */
function runDetails(event: ProjectOverviewActivityDto, trigger?: string) {
  const size = event.scopeSize;
  return [
    trigger,
    size === undefined ? undefined : `${count.format(size)} in scope`,
    event.newVulnerabilities === undefined
      ? undefined
      : `${count.format(event.newVulnerabilities)} new`,
    event.recurringVulnerabilities === undefined
      ? undefined
      : `${count.format(event.recurringVulnerabilities)} recurring`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Limits activity labels to project changes understood by this console. */
function changeSummary(event: ProjectOverviewActivityDto) {
  const actor = event.actorName?.trim();
  if (event.kind === 'dismissed') {
    const total = event.count;
    return {
      title:
        total === undefined
          ? 'Findings dismissed'
          : `${count.format(total)} ${total === 1 ? 'finding' : 'findings'} dismissed`,
      detail: [
        event.reason &&
          Object.hasOwn(dismissalLabels, event.reason) &&
          dismissalLabels[event.reason],
        actor,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }

  const title =
    event.ref === 'project.updated' &&
    event.change &&
    Object.hasOwn(changeTitles, event.change)
      ? changeTitles[event.change]
      : auditTitles.get(event.ref);
  return {
    title: title ?? 'Project updated',
    detail: [
      event.workflowName?.trim(),
      event.added ? `${count.format(event.added)} added` : undefined,
      event.removed ? `${count.format(event.removed)} removed` : undefined,
      actor,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

function ActivityChange({
  event,
  projectId,
}: {
  event: ProjectOverviewActivityDto;
  projectId: string;
}) {
  const { title, detail } = changeSummary(event);
  const destination =
    event.ref === 'project.updated' && event.change
      ? changeDestinations.get(event.change)
      : undefined;
  const linkClass =
    'rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring';
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium">
        {event.kind === 'dismissed' ? (
          <Link
            to="/projects/$id/findings"
            params={{ id: projectId }}
            search={{ status: 'dismissed' }}
            className={linkClass}
          >
            {title}
          </Link>
        ) : destination ? (
          <Link
            to={destination}
            params={{ id: projectId }}
            className={linkClass}
          >
            {title}
          </Link>
        ) : (
          title
        )}
      </p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** Shows the run's saved metadata and only offers links with job read access. */
function ActivityRun({
  event,
  canOpen,
  date,
}: {
  event: ProjectOverviewActivityDto;
  canOpen: boolean;
  date: string;
}) {
  const name = event.workflowName?.trim() || 'Workflow run';
  const trigger =
    event.jobRunType === 'scheduled'
      ? 'Scheduled'
      : event.jobRunType === 'manual'
        ? 'Manual'
        : undefined;
  const detail = runDetails(event, trigger);
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        {canOpen ? (
          <Link
            to="/jobs/runs/$id"
            params={{ id: event.ref }}
            aria-label={[name, trigger, date].filter(Boolean).join(', ')}
            className="rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {name}
          </Link>
        ) : (
          <p className="text-sm font-medium">{name}</p>
        )}
        {detail && (
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
      {event.runStatus && <JobStatusBadge status={event.runStatus} />}
    </div>
  );
}

/** Renders the bounded timeline in the same order returned by the server. */
export function ProjectOverviewActivity({
  projectId,
  events,
  canOpenRuns,
}: {
  projectId: string;
  events: ProjectOverviewActivityDto[];
  canOpenRuns: boolean;
}) {
  return (
    <section
      aria-labelledby="project-recent-activity-heading"
      className="min-w-0 space-y-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <h2
        id="project-recent-activity-heading"
        className="text-base font-semibold"
      >
        Recent activity
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No project activity yet.
        </p>
      ) : (
        <ol
          aria-label="Project activity entries"
          tabIndex={0}
          className="max-h-[30rem] divide-y overflow-y-auto rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          {events.map((event, index) => {
            const date = eventDate.format(new Date(event.at));
            return (
              <li
                key={`${event.kind}-${event.ref}-${event.at}-${index}`}
                className="grid min-w-0 gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3"
              >
                <time
                  dateTime={event.at}
                  className="text-xs tabular-nums text-muted-foreground"
                >
                  {date}
                </time>
                {event.kind === 'run' ? (
                  <ActivityRun
                    event={event}
                    canOpen={canOpenRuns}
                    date={date}
                  />
                ) : (
                  <ActivityChange event={event} projectId={projectId} />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
