# AI finding proposals and human review

Release source: Open ASM v0.12.1, `961d77142671e90190bd97132638441e593bec47`.
This port preserves Argus branding, discussions, project chats, approval modes
and the stronger scanner evidence and locking rules already in Dev.

## Storage and rollout

`AddFindingProposalReview` adds review/discovery state and nullable review/source
attribution to the existing finding tables. Existing rows read as approved
scanner findings. No historical AI attribution is guessed. Deploy the migration
before the API/console. It creates the review-status index and SET NULL
references for reviewer, submitting user and conversation.

Stop new writers and retain a database backup before downgrade. The generated
migration's rollback takes table locks and refuses to remove non-default state,
review decisions, AI attribution or proposal/review history. It does not delete
or silently convert those records to make a rollback pass. Use the older
application only after an operator has preserved and reconciled that data.
Apply or revert migrations only through the repository Task entries.

## Proposal and decision behavior

The conversation-only AGENT tool `propose_vulnerability` requires execution-time
`vulnerability.write`, the caller's conversation, current workspace membership,
and any project asset scope. The existing plan, todo, manual approval and Stop
controls apply. Evidence contains bounded requests, responses and a baseline.
Cited calls must belong to the authorized chat or its subagents. AI-only proof
does not count as a scanner observation, comparable scan, miss or fix.

New proposals are pending. Repeating a pending proposal refreshes its proof;
repeating a rejected proposal retains rejection. Verification of an approved
same-asset finding adds proof without changing its scanner lifecycle or SLA.

Selected-workspace review endpoints under `/api/vulnerabilities` provide single
approval, rejection, merge, duplicate candidates and bulk approval/rejection.
Writes require `vulnerability.write`; candidates require `vulnerability.read`.
Approval starts detection and the saved SLA now, recording one detection.
Rejection requires a reason and keeps the proposal and proof. Merge requires a
pending proposal and an approved finding on the same asset, and preserves proof,
discussion/replies and recorded history before removing the proposal.

Each bulk item has its own transaction. A response failure can follow committed
decisions. The console never retries a dispatched review automatically. Refresh
saved state, inspect the remaining proposals, then explicitly discard the local
attempt before making a fresh decision. Checking saved state alone does not
unlock an uncertain write. Workspace changes and unmounts abort stale requests
and suppress their navigation/toasts.

## Read consistency and privacy

Pending and rejected proposals have their own list filters and queue count;
all existing finding statuses, including `all`, contain approved findings only.
Dashboard, target/project feeds, reports, trends, lifecycle and MTTR totals
exclude unapproved rows. Human approval supplies the detection date for trends
and SLA; storage creation-time filters keep their original meaning.

Finding readers can view proof deliberately attached to the finding, rendered
as escaped text. Source run references still require job read access and valid
workspace provenance. Chat/call links additionally require agent read access
and ownership of that conversation. User objects contain only ID, name and
image. Scanner scope/coverage, private actor IDs and raw event metadata remain
private. Audit events contain IDs and outcomes, excluding proof and notes.

Human-approved detections can start existing project event triggers. Dispatch
revalidates the committed approval event, actor, asset, finding and tenant, and
deduplicates by that event's ID. It creates no fabricated scanner job or scan
coverage. Legacy scanner detections retain their existing dispatch path.

## Validation

Validate upgrade, safe rollback/re-upgrade and the refusal to lose real review
data against disposable local Docker Postgres. Cover competing decisions,
repeated proposals, source identity collisions, preserved merge discussions,
tenant/project/chat/call boundaries and approved-only aggregates. Dedicated
review/proposal service suites exceed 80% line coverage. Run full API/console
tests, sequential lint and both builds.

Browser checks use the isolated local Docker deployment and deterministic local
model fixture with synthetic `.test` assets. Exercise desktop/mobile proposal
creation, source/status filters, escaped proof, approve/reject/merge, offline and
partial-bulk recovery, stale responses and read-only access. Recheck existing
lifecycle controls, discussions, Templates, project AI and Files. No external
model, connector scan, or recipient is needed for these checks.
