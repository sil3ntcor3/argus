# Project finding observations

The private `project_vulnerability_observations` table records a known run that
reported a project finding. Its unique `(projectVulnerabilityId, jobHistoryId)`
pair provides the persistence needed to deduplicate callbacks from the same run.
Runtime ingestion of observations and repeat-count updates follow separately;
this foundation does not change existing finding responses or notifications.

Deleting a run sets its observation's `jobHistoryId` to null. The observation,
its `seenAt` timestamp, and the finding link's aggregate count and dates survive.
Deleting the project finding link cascades to its observations. It does not
delete the underlying workspace finding or run.

## Migration and existing data

`AddProjectVulnerabilityObservations1793965574242` creates the table, its unique
constraint, history index, and foreign keys. It backfills distinct known first
and last run references only when the run belongs to the same project and both
the workflow and finding asset belong to that project's workspace. When both
references identify one run, the earlier recorded timestamp is retained.

Unknown history and inconsistent legacy references remain unattributed. The
backfill does not infer intermediate runs or rewrite existing `timesSeen`,
`firstSeenAt`, or `lastSeenAt` values. An existing count can therefore exceed the
number of recoverable historical observations.

Back up the database before deployment and apply migrations through the normal
migration service. For a local database, use `task migration:run` after checking
the configured database. To roll back, first stop application instances that
depend on observations, confirm this is the latest applied migration, then use
`task migration:revert`. Rollback removes the new observations table and leaves
the existing finding links, counts, dates, runs, and findings intact. Back up
observations too before reverting a deployment that has begun recording them.

## Validation

`core-api/test/project-provenance.e2e-spec.ts` checks unique run sightings,
foreign keys, deletion behavior, and existing API privacy and workspace access.
Migration validation should cover duplicate first/last references, distinct
runs, missing history, mismatched project/workflow/finding workspaces, and
upgrade/rollback/reapply without changing existing aggregates.
