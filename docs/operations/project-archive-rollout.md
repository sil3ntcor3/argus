# Project archive and reopen

This ports the project archive lifecycle from Open ASM v0.12.1 while retaining Argus branding, permissions, saved workflows and existing routes.

## API and console

Project writers can archive or reopen a project from its card or Settings. Both operations are idempotent and return the current project metadata. Canonical project lists default to active projects; `status=archived` and `status=all` include archived projects before pagination. The legacy Groups list remains unfiltered by default.

Archived projects retain assets, files, workflows, triggers, findings, conversations and run history. Content, scope, file associations and workflow/trigger mutations are rejected. Generic saves and deletes of a project-owned workflow are also guarded. Historical reads and explicit project deletion retain their existing permissions. Runs already in progress are not cancelled by archive.

`project.archived` and `project.unarchived` use the existing event and audit pipeline. Requests require the selected workspace and effective project write permission (including Argus's existing aliases). No schema or configuration migration is needed.

## Scheduling and recovery

Archive preserves cron expressions and desired trigger enabled flags. Scheduler keys are invalidated transactionally, with fresh opaque lifecycle markers stored in the existing private scheduler fields. Reopening restores the saved desired schedules. A single coordinated repair restores legacy schedules before deduplicating equivalent project triggers at startup and every five minutes.

Redis cleanup failures do not undo a committed state change. Launch validation rechecks the project, workflow, binding and lifecycle under database locks. Pending, queued and drained event windows are isolated by lifecycle generation. Events produced before reopening are not gathered for a reopened trigger; source timestamps must include a timezone after a project has cycled through archive. Previously observed delivery IDs remain deduplicated.

A lost HTTP response does not automatically replay an action. The dialog offers a fresh saved-state check. A confirmed transition updates the page; a confirmed unchanged state allows an explicit idempotent retry. Workspace changes and offline state block new writes.

## Validation and rollback

Validate in an isolated local Docker deployment: archive/reopen, active/archived/all pagination, historical reads, read-only controls, desired schedule preservation, Redis failure recovery, delayed/in-flight events, concurrent repair and delivery before schedule publication commits. Check desktop and mobile layouts, offline behavior and ambiguous receipt recovery.

To reverse an accidental archive, reopen the project. Application rollback requires care: older images do not understand lifecycle markers or archive guards. Stop project schedule/event consumers before reverting application code, keep projects paused, and reconcile their desired schedules using the current version before re-enabling delivery. No database migration rollback is involved.
