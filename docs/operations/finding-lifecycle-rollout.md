# Finding lifecycle rollout (Open ASM v0.12.1)

This port uses release commit `961d77142671e90190bd97132638441e593bec47`.
Argus branding, user dismissals, archive decisions, project provenance and
merged features remain in place. This batch uses the existing private lifecycle
and resolution storage; it adds no migration or dependency.

## Workspace policy

Finding settings are readable with effective `vulnerability.read`; saving needs
`workspace.config`. Partial saves preserve unrelated workspace settings and
omitted policy fields. Concurrent policy saves serialize on the workspace row.
The console submits only fields edited from the draft's original baseline.

Release defaults are SLA days critical 7, high 30, medium 90, low 120 and info
null; restart on resurfacing is enabled. Automatic closure is enabled after one
trusted comparable missed run. The risk acceptance maximum is 180 days.
SLA and risk limits accept 1–3650 days; the miss threshold accepts 1–10.
Saving an SLA policy recomputes open deadlines, including the latest resurface
anchor after a subsequent detection has made the finding active. Explicit null
means no SLA. Existing timed risk acceptances retain their saved expiry when
the maximum changes.

Existing findings receive deadlines on a later positive observation or explicit
SLA policy save. There is no deployment-time backfill or schema change.

## Evidence and ordering

Only complete trusted scans can prove absence. The stored claim, complete
coverage marker, immutable connector image, resolved inputs/configuration,
asset and tool must match. Legacy/HTTP/partial reports still ingest positives;
unknown coverage, changed scope and cancelled or unfinished runs cannot close
findings. Workflow-free saved-template runs must prove every job belongs to the
same workspace and has the server-owned template selection marker.

Closure recomputes distinct comparable missed runs from durable evidence under
finding locks. The cached miss counter is never closure authority. A positive
source in a run excludes that run as negative evidence for the finding.
Workspace and protected history parents are locked before findings, in stable
order. If retention holds the newest proof's parent, closure defers until a safe
replay. A fresh statement rechecks evidence after waiting for finding locks.

`fixedAt` and the status event use the same database statement timestamp. The
private event also stores the newest negative scan's absolute claim cutoff.
A delayed positive can resurface only with a later saved claim; callbacks from
older or unknown claims cannot reverse a newer fix. The cutoff lookup checks
finding, workspace, fixed status, reason/version and exact event/fix timestamp.
Malformed, ambiguous, nonfinite, future or timezone-less data falls back to the
fix timestamp. Parsing and comparisons remain in PostgreSQL to retain
microseconds. Deleting a closing run clears its reference, not the event cutoff.

Each run counts a positive once. Resurfacing clears stale fix/run/actor claims,
updates positive run provenance and applies the saved SLA restart policy.
Archive and dismissal decisions remain separate from scanner detection state.

## Reads, claims and audit

List/detail DTOs expose recognized scanner state and counts, deadlines and fix
timestamps. Run references require effective job read access and workspace
ownership. The undocumented origin run relation is omitted so it cannot bypass
that boundary. User summaries contain only ID, name and image. Scope digests,
observation cutoffs, cached misses and raw claim notes stay private.

Open counts across finding, project, target, dashboard and report queries use
the same predicate: detected, not archived, and no effective dismissal.
Expired risk acceptances stop suppressing a finding before cleanup runs.
Detection filters/counts agree; fixed counts describe stored scanner-fixed
rows. Remediation averages cover valid fixes from the last 90 days.

REST `createdFrom` and `createdTo` now filter first detection, falling back to
creation time only when a legacy finding has no detection timestamp. The lower
bound is inclusive and the upper bound includes the full UTC day. Console date
links preserve calendar dates in local time; the filter is labeled First detected.
Consumers that previously used these parameters for insertion time must update
their interpretation. There is no new query parameter or data rewrite.

Project finding lists accept open, new, active, resurfaced, fixed, dismissed,
pending_review, rejected and all. Open remains the default; all includes only
approved findings, including archived ones. Explicit review filters additionally
require effective vulnerability read access; approved project reads still need
only project read. Resolution labels prefer fixed over dismissal. Review state
is identified by the selected filter, and review rows do not offer run timelines.
Project timelines remain approved-only and retain tenant and run redaction.

These REST and console changes require coordinated API/client deployment. A
rollback restores the previous filter/label behavior without changing stored data.

Mark fixed records an atomic workspace-scoped claim for 1–1000 IDs, with an
optional private note. It neither closes a finding nor launches a scan. A
covering scan begun after the claim can verify it. Timeline output includes
only recognized verification fields and retains existing run redaction.
`fixClaimVerified: false` does not imply a claim existed.

Policy saves publish `vulnerability.settings.updated` using recognized requested
keys and resolved saved values. Trusted closures publish `vulnerability.fixed`
after commit with scoped identities and a count. Claims reuse the existing
status audit event. No notes, raw results or credentials enter these events.

New policy/claim controls suppress stale callbacks across workspace changes,
block offline writes and duplicate submissions, and require an explicit saved
state check after an ambiguous response. They do not replay queued writes.

## Validation and rollback

Validate on local Docker Postgres/Redis and the local API/console images. Cover
positive/negative lock races, duplicate and delayed callbacks, parent deletion,
claim timing, changed images/scopes, cancellation, policy concurrency, tenant
permissions, private metadata, fixed-count agreement and desktop/mobile flows.
Do not use external targets or paid model calls for this validation.

To halt new automatic closures, disable the workspace policy before changing
images. Keep findings and their recorded history. This feature has no schema
rollback. Older application images may include scanner-fixed findings in open
counts; verify that behavior before using an application rollback operationally.
