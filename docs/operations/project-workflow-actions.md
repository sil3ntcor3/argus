# Project workflow actions (Open ASM v0.12.1)

Release boundary: `961d77142671e90190bd97132638441e593bec47`.
This adds canonical workflow listing, launch and removal. Legacy routes,
Argus branding, trigger controls and previously merged extras remain available.
No migration, dependency or CI changes are required.

- `GET /api/projects/:id/workflows` requires effective `project.read` in the
  selected workspace. It returns deterministic bindings, masked connector
  configuration and recognized triggers without private scheduler identifiers.
  `lastRun` is null without effective job read access. Archived projects remain
  readable.
- `POST /api/projects/:id/workflows/:bindingId/run` requires both `project.write`
  and the existing `workflow.write` launch permission. Omit `assetIds` for all
  enabled project assets, or supply 1–5,000 unique UUIDs. The launch transaction
  rechecks the current binding, workflow revision and workspace asset scope.
  Its 201 receipt contains the durable `jobHistoryId` and actual asset count.
- `DELETE /api/projects/:id/workflows/:bindingId` requires `project.write` and
  rejects archived projects. It removes the binding and its triggers. Shared
  or reused workflows survive; an exclusively owned definition and its runs
  and jobs are deleted. Findings survive with nullable run provenance cleared
  by existing foreign keys. Take normal database backups before deletion.

Removal publishes the existing project workflow-removal audit. Scheduler work
follows the database commit; Redis cleanup failure cannot hide a committed
removal. Periodic reconciliation cleans project-trigger keys, and the existing
schedule consumer removes orphan legacy repeats when delivered. Cleanup never
sweeps arbitrary legacy scheduler keys. Legacy schedule saves use the same
project/workflow/binding locks and explicit updates to prevent resurrection
after a concurrent removal.

The console uses canonical list/run/removal routes and navigates job readers to
the returned run ID. It blocks duplicate/offline writes, bounds transport waits
to 30 seconds, and retains unknown outcomes across dialog/page remounts in the
originating workspace. Check project Runs or the refreshed workflow list before
explicitly allowing another request; a transport error does not prove failure.

Validation covers cross-workspace IDs, both launch permissions, selected scope,
same-timestamp workflow edits, concurrent scope and legacy scheduler writes,
shared workflow preservation, scheduler cleanup and finding retention. Rollback
to the preceding image disables the new routes without reverting storage.
It does not restore definitions or runs already removed.
