# Argus projects module

Projects organize workspace assets with manual selection, inclusion rules, and exclusions. They own workflow assignments and present run and finding provenance. Keep lookup and write checks in the selected workspace. Archived projects are historical views.

- The read side includes project metadata, assets, Overview, activity, workflow assignments, runs, and findings. Project routes use the `project.*` keys and existing compatibility aliases. Conditional run and finding fields also respect their domain permissions.
- `ProjectScopeDiscoveryService` links new assets from the event bridge. Scope rule writes and manual asset changes preserve provenance and serialize concurrent edits. An excluded asset stays excluded from automatic linking until the exclusion is removed.
- Project workflow creation accepts exactly one workspace template, selected job graph or same-workspace binding to copy, creating its disabled binding atomically. Copies preserve encrypted config and strip schedules/triggers; scope both the source project and workflow. Selected jobs reuse the pipeline editor's graph, tool/input, profile and secret validation. Workflow launches use enabled project assets and record the project and binding on the job history. Keep target-only runs separate from project provenance.
- Job and finding read models distinguish the original discovery, project membership, and findings attributed to a specific run. When a binding or project is removed, historical references follow their foreign-key behavior.

Use scope, workflow, and provenance specs. Validate ownership and lock ordering against local Docker Postgres.

`ProjectTriggerRuntimeModule` is shared globally by commands, the projects event sink, and the existing schedule consumer. Keep legacy binding schedules and the queue's compatibility name. Reconciliation may remove only `project-trigger:` schedulers; a stored legacy job ID is not proof the scheduler still exists. Definitions/rows are transactional; scheduler work follows commit.

Event gathering uses recoverable Redis windows and stable queue tokens. Freeze chunk size in the claimed snapshot and derive durable run IDs from token/chunk identity. `WorkflowRunnerService.startRun` serializes that identity before creating a run, so launch retries must reuse it. Check current enabled membership, target/workflow ownership, cancellation and chain depth inside the launch transaction. Private causal fields must not appear in public read models.

The private `PROJECT_RUN_CLOSED` signal is a one-part symbol path because EventEmitter2 runs with wildcard mode. It fires on committed closure even when no job exists; job-backed statistics keep their existing signal. Completion events require authoritative closed/non-cancelled evidence.

Finding counts/feeds include approved findings only. Human approval can emit
`vulnerability.detected` without a scanner job. `ProjectTriggerRuntimeService`
validates its private `approvalEventId` against the committed approval event,
actor, review time and finding/asset/workspace; deduplicate by that durable event
ID. This path supplies no scanner coverage or causal run. Preserve the existing
job-backed detection path and its evidence checks.

Public finding feeds stay approved-only. The private `listForAgent` path also
supports explicit lifecycle and proposal-review statuses for authenticated,
project-authorized tools. Keep it separate from REST filters/response semantics
and scope every row through the project's workspace and recorded finding links.
