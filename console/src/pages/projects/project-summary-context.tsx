import { Badge } from '@/components/ui/badge';
import { formatNextRun, getLocalTimezone, getNextRun } from '@/lib/cron-schedule';
import type { ProjectListItemDto } from '@/services/apis/gen/queries';

export const projectEventLabels = {
  'project.assets.added': 'Assets added',
  'project.run.completed': 'Run completed',
  'vulnerability.detected': 'Finding detected',
} as const;

/** Shared labels stay bounded to recognized model values, including stale clients. */
export function projectRunTrigger(jobRunType?: string, event?: string | null) {
  if (jobRunType === 'event') return event && Object.hasOwn(projectEventLabels, event)
    ? projectEventLabels[event as keyof typeof projectEventLabels] : 'Event';
  return jobRunType === 'scheduled' ? 'Scheduled' : jobRunType === 'manual' ? 'Manual' : undefined;
}

/** Summarize saved triggers without exposing their scheduler identity/configuration. */
export function ProjectSummaryTriggers({ project }: { project: ProjectListItemDto }) {
  if (project.archivedAt) return <Badge variant="outline">Triggers off</Badge>;
  const enabled = (project.triggers ?? []).filter(t => t.enabled);
  const events = [...new Set(enabled.flatMap(t => t.type === 'event' && t.event && Object.hasOwn(projectEventLabels, t.event) ? [t.event] : []))];
  const cron = enabled.filter(t => t.type === 'cron' && t.cron);
  // The existing builder helper cannot represent restricted months. An unknown
  // schedule could fire before any supported one, so omit the overall estimate.
  const times = cron.map(t => t.cron!.trim().split(/\s+/)[3] === '*'
    ? getNextRun(t.cron!, 'UTC') : null);
  const next = times.length && times.every((time): time is Date => time !== null)
    ? times.sort((a,b) => a.getTime()-b.getTime())[0] : undefined;
  return <div className="flex flex-wrap items-center gap-2">
    {cron.length > 0 && <Badge variant="outline">Schedule</Badge>}
    {events.map(event => <Badge key={event} variant="outline">{projectEventLabels[event]}</Badge>)}
    {!cron.length && !events.length && <Badge variant="outline">No enabled triggers</Badge>}
    {next && <span className="text-xs text-muted-foreground">Next scheduled (estimate): <time dateTime={next.toISOString()}>{formatNextRun(next, getLocalTimezone())}</time></span>}
  </div>;
}

/** Finding summaries are additionally gated on current permissions, not cached row data. */
export function ProjectSummaryFindings({ project, canRead }: { project: ProjectListItemDto; canRead: boolean }) {
  if (!canRead || !project.openVulnerabilities) return null;
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <p aria-label="Open findings by severity" className="text-muted-foreground">
      {(['critical','high','medium','low','info'] as const).map(severity => `${project.openVulnerabilities![severity]} ${severity}`).join(' · ')}
    </p>
    {!project.archivedAt && (project.newVulnerabilities ?? 0) > 0 && <Badge variant="secondary">+{project.newVulnerabilities} new</Badge>}
  </div>;
}
