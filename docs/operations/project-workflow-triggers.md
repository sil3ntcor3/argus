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
