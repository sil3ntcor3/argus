# Findings and lifecycle

Finding ownership follows `vulnerability → asset → target → workspace`. Scope
reads and writes through that path. The timeline also checks the event's
workspace, and run IDs are visible only with effective job read access and a
run in that workspace.

- Scanner detection state and user dismissals are separate. A dismissal does
  not turn a scanner finding into a fixed finding. When adding a read view,
  reuse the existing open-finding and dismissal predicates so counts agree.
- Timed risk acceptance stops suppressing a finding at its expiry, even
  before background cleanup removes the dismissal. Cleanup records a private
  event and uses locked, bounded batches. Legacy dismissals are indefinite.
- Timeline events describe recorded transitions and decisions. The public
  timeline uses `readFindingTimeline` to project a limited actor (`id`, `name`,
  `image`) and type-specific `VulnerabilityTimelineDataDto` fields; never return
  raw event metadata. Conversation context needs effective agent read, current
  ownership and the selected workspace. Issue references need effective
  workspace read and a current issue in that workspace.
- Scanner sighting counts and resurface events are written in the data adapter.
  A late or ambiguous result may contribute a positive sighting without
  reopening a fixed finding. Absence closes a finding only through the trusted
  durable coverage accounting path, under the saved workspace policy. Never
  infer absence from an empty/partial HTTP result or cached miss count.
- Policy saves lock the workspace before recomputing deadlines. Positive
  ingestion and claims take a workspace parent lock before finding locks.
  Finding locks use fingerprint then ID order, including dismissal/reopen.
- Lifecycle reads use dedicated DTOs and scoped run references. Keep raw scope,
  observation times and cached misses private. Claim notes are exposed only as
  bounded plain-text context on their recorded `fix_claimed` timeline event.

See `docs/operations/finding-lifecycle-rollout.md` for evidence, cutoff and
rollback requirements.

Use the controller and service specs for permission and response changes.
Use Docker Postgres for expiry, row-locking and event ordering checks.

AI proposals have `reviewStatus=pending_review` and enter approved counts only
through `VulnerabilityReviewService`. Rejection retains proof; merge moves
sources, comments and history into an approved finding on the same asset before
deleting the proposal. Bulk items commit separately; a failed response does not
prove nothing saved. Review decisions lock parents before fingerprint/ID-ordered
findings. `VulnerabilityProposalService` validates current chat/project ownership
and cited calls at execution time; AI evidence never creates scanner coverage.
List `createdFrom`/`createdTo` filters use first detection with a legacy creation-date fallback and a UTC end-of-day upper bound. Bind the timestamp and timestamptz branches separately to preserve legacy clocks.
Use `findingDetectedAt` for detection-date aggregates and the projections in
`vulnerability-review-read.ts` for authorized source references and limited user
objects. See `docs/operations/finding-proposal-review-rollout.md`.

New approval/rejection, proposal/AI verification and merge events record their
decision or source context atomically with the existing write. Do not fill
missing historic context from current mutable finding/source values.
`projectFindingReview` adds only `logoUrl` to detail source tool references;
list source summaries remain compact. See `docs/operations/finding-timeline-context.md`.

Finding list/detail openIssue references require effective workspace access. issue_linked is public timeline activity; issue_automation proof receipts remain private. Dedicated CommentsService continues to own discussions.
