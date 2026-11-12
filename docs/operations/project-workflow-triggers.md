# Project workflow trigger storage

The private `project_workflow_triggers` table stores a binding reference,
cron/event type, optional cron and event values, JSON configuration, an enabled
flag, and optional last-fired time and scheduler ID. Standard UUID and timestamps
come from the existing base entity. The binding foreign key cascades deletion,
and `IDX_pwt_projectWorkflowId` supports lookup and cleanup.

This foundation adds persistence without backfilling legacy schedules or
registering a dispatcher. Existing binding `schedule` and `jobId` fields stay
active. Trigger API contracts and runtime behavior follow separately.

The approved migration is generated with
`task migration:generate name=AddProjectWorkflowTriggers`. Verify upgrade,
rollback, reapplication and legacy-row preservation on disposable local
Postgres. Run `task api:test:e2e:one SPEC=test/project-workflow-trigger-storage.e2e-spec.ts`
for defaults, JSON settings, foreign-key and cascade behavior.

`GET /api/projects/:id/triggers` requires workspace project read access, including
archived projects. It orders by creation time/ID, checks workflow ownership and
omits scheduler IDs/unknown settings. Reads never register schedules or run jobs.

Private event configuration helpers validate event-specific settings before
applying defaults. Their returned arrays are independent copies. They are not
wired to the read API, persistence, queues or dispatcher.

Private `on` parsing canonicalizes validated project definitions without writing
or scheduling them. It leaves legacy `target` data untouched; future writers
must preserve that data when updating a workflow's `on` block.

The private synchronization planner takes one authorized binding's rows and
validated definitions. It preserves runtime state, retains disabled duplicates,
and returns a plan without applying persistence or scheduler operations.

Private editor-input conversion keeps definitions separate from explicit state
choices. The first duplicate entry wins, including an omitted state; callers
retain existing runtime choices unless an override was explicitly supplied.

Private matching helpers select enabled, valid event rows by workflow/outcome or
finding severity and return independent asset arrays. The caller still owns
tenant/project scope and launch-time asset/type/cause/chain checks. Batch splitting rejects
nonpositive or unsafe sizes. These helpers add no dispatcher or automatic runs.

Private run eligibility requires authoritative closed-run and zero active/cancelled
job evidence; graph steps alone cannot prove a run was not cancelled. Unknown or
cancelled states suppress an outcome. Causal planning caps depth at three and
excludes same-binding completion/finding loops, while retaining bounded discovery.
Callers still validate tenant/project/run identity; no event publication is wired.

Project workflow edits share the existing scoped workspace → project → workflow →
binding locks and owned/editable checks. The shared helper keeps transaction and
permission ownership with its caller, ready for later disabled-trigger persistence.

The private definition writer atomically appends one validated definition and its
disabled row under those locks. It rejects file/row duplicates, preserves legacy
binding schedules and authored configuration, and rolls back both writes on failure.

`POST /api/projects/:id/triggers` (`project.write`) creates one disabled trigger.
Unknown fields/duplicates return 400; successes emit `project.updated` (`change=triggers`).

Generic workflow saves serialize workspace/workflow access and preserve the stored
`on` block for project-bound workflows with trigger rows, including omitted fields
from legacy clients. Other workflows retain their existing schedule-edit behavior.
The public schedule type accepts a legacy string or a list of `{cron}` entries.

Project workflows displays the saved triggers for each binding through the existing
read API, including UTC schedules, events, enabled state and last-fired timestamps.
The list is read-only and keeps legacy schedule controls separate. Access failures
hide cached rows; transient failures offer an explicit retry.

Project writers can add a disabled UTC schedule trigger to an editable, owned
workflow in an active project. Creation refreshes the trigger list and saved YAML
while preserving legacy schedules. Pending submissions block duplicates across
remounts; transport/408/5xx failures require checking the list before retrying.

The console's shared `useProjectTriggerCreate` hook owns these existing submission
and cache safeguards. The schedule dialog retains its validation, messages and
focus behavior; this extraction prepares reuse by later event-trigger forms.

Project writers can add disabled event triggers for new assets, completed runs of
other workflows, or findings. The dialog starts with the existing default
filters and accepts a 0–1440 minute gather window and 1–5000 assets per batch.
It shares schedule creation's pending, uncertain-response and workspace guards.

Event creation also supports target-type filters, up to 20 followed project
workflow names and one or more run outcomes, or one or more finding severities.
An empty target-type or workflow selection means any; outcomes default to success
and severities to critical/high. Only the selected event's settings are sent.
