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
