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
  timeline maps recognized fields and never returns raw metadata or actor IDs.
- Scanner sighting counts and resurface events are written in the data adapter.
  A late or ambiguous result may contribute a positive sighting without
  reopening a fixed finding. Absence closes a finding only through the trusted
  durable coverage accounting path, under the saved workspace policy. Never
  infer absence from an empty/partial HTTP result or cached miss count.
- Policy saves lock the workspace before recomputing deadlines. Positive
  ingestion and claims take a workspace parent lock before finding locks.
  Finding locks use fingerprint then ID order, including dismissal/reopen.
- Lifecycle reads use dedicated DTOs and scoped run references. Keep raw scope,
  observation times, cached misses and claim notes out of public responses.

See `docs/operations/finding-lifecycle-rollout.md` for evidence, cutoff and
rollback requirements.

Use the controller and service specs for permission and response changes.
Use Docker Postgres for expiry, row-locking and event ordering checks.
