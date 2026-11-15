import type { VulnerabilityTimelineEventDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

/** Render recorded text literally; linked context also needs current UI access. */
export function FindingTimelineDetails({
  event,
  canOpenAgents,
  canOpenIssues,
}: {
  event: VulnerabilityTimelineEventDto;
  canOpenAgents: boolean;
  canOpenIssues: boolean;
}) {
  const data = event.data;
  if (!data) return null;
  const note = ['approved', 'rejected', 'fix_claimed'].includes(event.type)
    ? data.note
    : ['dismissed', 'risk_expired'].includes(event.type)
      ? data.comment
      : undefined;
  const agent =
    ['proposed', 'verified_by_ai'].includes(event.type) &&
    canOpenAgents &&
    data.agentConversationId;
  return (
    <div className="space-y-1.5 text-sm text-muted-foreground">
      {note && <p className="whitespace-pre-wrap break-words">{note}</p>}
      {event.type === 'approved' && data.severity && (
        <p>
          Approved as <span className="capitalize">{data.severity}</span>
          {data.proposedSeverity && (
            <>
              {' '}
              (proposed{' '}
              <span className="capitalize">{data.proposedSeverity}</span>)
            </>
          )}
        </p>
      )}
      {event.type === 'status_changed' && data.reason && (
        <p>
          {data.reason === 'detected_by_scan'
            ? 'Reported again by a scan.'
            : 'No longer reported by a covering scan.'}
        </p>
      )}
      {agent && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {data.agentName && (
            <span className="break-words">Agent: {data.agentName}</span>
          )}
          <Link
            to="/aistudio/conversations/$conversationId"
            params={{ conversationId: data.agentConversationId! }}
            className="text-primary underline"
          >
            View conversation
          </Link>
        </div>
      )}
      {event.type === 'merged' && (
        <>
          {data.proposalName && (
            <p className="break-words">Proposal: {data.proposalName}</p>
          )}
          {typeof data.movedSources === 'number' && (
            <p>{data.movedSources} source(s) moved here.</p>
          )}
        </>
      )}
      {event.type === 'issue_linked' && canOpenIssues && data.issueId && (
        <Link
          to="/issues/$id"
          params={{ id: data.issueId }}
          className="text-primary underline"
        >
          View issue #{data.issueNo}
        </Link>
      )}
    </div>
  );
}
