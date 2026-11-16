# Project finding lifecycle views

The v0.12.1 port retains Argus's dedicated project finding cards and recorded
provenance. Project-wide summary counts use `project_vulnerabilities`, even
after an asset leaves current project membership, and verify the finding's
asset/target workspace. The list's severity and provenance facets ignore only
their own selected dimension. Statistics ignore list filters entirely.

`GET /api/projects/:id/vulnerabilities` adds source, overdue, first-detection
dates, the bounded finding filter tree and explicit sorting. Values are bound
parameters. Sort keys are allowlisted, missing dates sort last, and ID ties
are stable. The default remains severity descending then project last sighting
descending. Date bounds use first detection with a legacy creation-date
fallback; the upper bound includes the full UTC day. Invalid calendar dates
are rejected. Project first/last sightings remain independent scanner context.

`GET /api/projects/:id/vulnerabilities/statistics` returns approved open
severity counts, lifecycle counts, recent detections/resurfacings/fixes, overdue
counts and per-severity remediation times. It reads one repeatable snapshot
using the existing lifecycle and active-dismissal predicates. Pending proposal
counts are null without effective finding-read access. Empty scopes have zero
counts and null remediation averages. Archived projects remain readable.

Project-only readers retain approved finding summaries and sighting timelines.
Pending/rejected list filters additionally require finding-read access. New
list fields contain only bounded lifecycle/action context; the active dismissal
reference excludes comments and actors. Expired risk acceptance is not active.
The console also gates cached proposal counts on current access.

Selection applies to visible IDs and resets with list/project/workspace scope.
Finding writes and issue creation use their independent permissions. Archived
projects have no write controls in this view. Fix claims do not close findings
or start scans; only trusted covering scans change scanner state. Reopen uses
dismissal IDs; linked issue creation uses finding IDs. Proposal reviews stay
separate from remediation selections.

Writes use the existing offline, duplicate-submit, workspace-change and
uncertain-outcome guards. A successful saved-state check does not automatically
repeat a review. Its acknowledgment survives a filtered refresh that unmounts
the dialog, and explicit local discard is still required before another review.
Access changes remount hook-bearing filter suggestions to avoid stale drafts.

Validate API/console suites, local Docker HTTP tests (combined filters, dates,
sorting, safe projections, ownership, summaries and existing sightings), and
desktop/mobile browser flows for summaries, filters, timeline, fix claims,
timed acceptance, Reopen, proposal review and linked issues. Include read-only,
independent permission, archived and lost-response cases. Use synthetic local
records and remove them after validation. No schema, dependency or worker
protocol changes are required; rollback is the application deployment only.
