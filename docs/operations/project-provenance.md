# Project provenance persistence

This persistence batch from upstream open-asm #819 adds private, nullable
`job_histories.projectId` and `projectWorkflowId` references and the
`project_vulnerabilities` table. Each project/finding pair has one row containing
first/last run references, timestamps and a count. Deleting a run nulls its
references and preserves findings and link history. Deleting a project or finding
removes its links. Deleting a workflow binding nulls the run's binding reference.

The existing Argus Groups UI, API responses, permissions, filters and audit names
remain unchanged. The new run columns are excluded from default ORM selections.
[New group run attribution](project-run-provenance.md) is implemented separately.
[Initial finding links](project-finding-links.md) are recorded during ingestion;
repeat-sighting timestamps and counts remain a follow-up.

## Conservative historical backfill

A run is attributed only when its workflow has exactly one current project
binding, the workflow and project belong to the same workspace, and its saved
name exactly matches the current project name. Its scope must be SQL NULL or a
JSON object without a `targetIds` key. Shared workflows, renamed projects,
target-scoped runs (including empty target lists), malformed scopes and foreign
workspace bindings remain unattributed rather than guessed.

Only findings whose asset belongs to the attributed project's workspace receive
a link. Each starts with count 1 and the finding's recorded run as both run
references. First/last timestamps use the finding's first-detected date, falling
back to its creation time interpreted as UTC. Historical repeats cannot be
reconstructed from the single saved finding/run pointer. Backfill runs once at
migration time, not at API startup or on subsequent runs.

## Upgrade and rollback

1. Back up the database and pause API replicas and run writers during migration
   so historical attribution is evaluated against a stable set of bindings.
2. Apply the [reviewed generated migration](../../core-api/src/database/migrations/1793925699930-AddProjectVulnerabilityProvenance.ts)
   with `task migration:run`. Docker's migration service gates API startup.
   Unrelated TypeORM drift was removed from this newly generated file.
3. Start the updated API and verify existing Groups, run detail and finding
   screens. No new endpoint, filter or permission is introduced.
4. To roll back this migration when it is last applied, stop updated writers,
   run `task migration:revert`, and restart the previous API image. Rollback
   removes only the added columns/table and their indexes/constraints, including
   derived provenance; original runs, findings, bindings and permissions remain.

## Regression validation

Use `task api:test:e2e:one SPEC=test/project-provenance.e2e-spec.ts` against local
test infrastructure for privacy, uniqueness, foreign keys, deletion behavior and
unattributed new runs. Also run the existing `asset-group-persistence` and
`auth-tenancy` e2e suites. For upgrade/rollback validation, seed historical runs
before applying the migration and check single-binding, shared, renamed,
target-scoped, malformed and cross-workspace cases, including timestamp fallback.
