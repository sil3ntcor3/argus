# Project workflow triggers (Open ASM v0.12.1 port)

This feature is ported from the frozen v0.12.1 release (`961d77142671e90190bd97132638441e593bec47`). Already-merged Argus extras remain; this batch imports no later upstream feature.

Project writers manage triggers on editable, project-owned workflows in the selected workspace. Archived projects remain readable and reject writes. New triggers stay disabled unless activation is explicit. The console supports creation, editing, activation and removal, with a confirmation before enabling automatic scans. Trigger reads omit scheduler IDs and unknown configuration keys.

## Contracts and definitions

- `GET /api/projects/:id/triggers` requires `project.read`.
- `POST /api/projects/:id/triggers` requires `project.write`; optional `enabled` defaults to false.
- `PATCH /api/projects/:id/triggers/:triggerId` accepts `cron`, `config`, and/or `enabled`. Type/event/binding are immutable. Event configuration patches merge into the saved settings. Empty, unsupported or invalid edits return 400.
- `DELETE /api/projects/:id/triggers/:triggerId` returns `{message: "Trigger removed"}`. Missing or inaccessible records return 404.
- Project workflow creation/update accepts optional `on: {schedule?, events?}`. Schedules contain `{cron, enabled?}` (maximum 20); events contain a recognized `event`, optional activation, and that event's filter settings (maximum three). Supplying `on` replaces managed definitions; omitting it preserves them. Existing activation is retained when omitted; new entries default disabled. First duplicate definitions win.

Definitions and trigger rows are written atomically under workspace → project → workflow → binding locks. Saved job graphs, encrypted configuration, instructions and legacy `on.target` are retained. Generic workflow saves preserve managed `on` definitions so older editors cannot erase them.

Legacy binding `schedule` / `jobId` fields remain operational. Reconciliation only removes scheduler IDs owned by this feature (`project-trigger:`). An identical *existing* legacy scheduler supplies a firing instead of registering a duplicate. A stale legacy reference does not prevent repair of an enabled trigger. Cron expressions use UTC. Registration is reconciled at boot, after trigger commands, and every five minutes.

## Events and dispatch

The projects event lane now handles `project.assets.added`, `project.run.completed`, and `vulnerability.detected`, alongside asset discovery linking.

- Assets-added triggers gather newly linked assets, including bounded discovery chains.
- Completion triggers follow other project workflows and filter by saved workflow names and success/failure. Outcomes come from authoritative closed-run state and current jobs, rather than the event's claimed outcome. Zero-job/no-inputs completion is supported.
- Finding triggers filter recognized severities, validate the recorded job/asset/workspace, and exclude findings produced by their own workflow.

Event windows coalesce assets, deduplicate deliveries for two days, apply current enabled-project membership and target types, and split at the configured asset limit. A recoverable snapshot freezes the batch size while processing. Queue redelivery retains the original window identity, including after a newer window opens. Durable deterministic run IDs prevent repeated handoff from creating duplicate runs/jobs. Failed flushes retry with backoff; retained failed jobs can be revived by redelivery.

Run provenance privately records the trigger, causal run, and depth. Depth is capped at three. Cancelled causes are rejected both during gathering and under a shared run lock at execution. Disabling or deleting a trigger invalidates pending windows; existing runs continue under the workflow engine. No worker protocol changes are needed. Run lists, filters and graphs distinguish the new `event` run type.

`project.run.completed` carries workspace-scoped project/binding/run IDs, workflow name and outcome. It excludes logs and secrets and is not persisted as an audit action. Successful trigger management continues to publish `project.updated` with `change=triggers`.

## Migration and validation

The explicitly approved migration is generated through:

```bash
task migration:generate name=AddProjectTriggerRunProvenance
```

It adds nullable `job_histories.triggerId` and `causedByRunId`, `chainDepth` defaulting to zero, SET NULL references, and the cause index. There is no historical attribution backfill. These fields are excluded from default reads and public response DTOs. The existing trigger table/binding cascade is retained.

Use `task migration:run` / `task migration:revert` only against a confirmed local disposable database. Validate rollback with the new runtime stopped, then reapply before starting it. Upgrade/rollback must preserve historical runs, existing scope, authored content, binding schedules and all unrelated schema.

Focused Docker suites: `project-trigger-provenance`, `project-trigger-batch`, `project-trigger-runtime`, and the existing workflow-create/trigger-storage/trigger-read/DAG suites, invoked with `task api:test:e2e:one SPEC=test/<name>.e2e-spec.ts`. Run `task lint`, `task test`, `task console:test:run`, and both builds. Regenerate tracked OpenAPI/client files with `task gen-api` from the freshly booted API. Validate desktop/mobile management, uncertain/offline writes, workspace changes, permissions, saved YAML, and real event dispatch on the isolated local Docker deployment.
