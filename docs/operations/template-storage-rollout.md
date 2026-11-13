# Templates storage rollout

Source boundary: Open ASM v0.12.1 (`961d77142671e90190bd97132638441e593bec47`), feature #804. Argus retains its immutable file publication and quota safeguards.

## Constraint foundation

`AllowTemplateArtifactRevisions` changes only two CHECK constraints on `artifacts`:

- Accept `template` alongside `upload` and `agent` sources.
- Accept a canonical immutable revision key only for template records. Each key embeds that row's workspace and artifact UUIDs and ends in a lowercase UUID revision. Existing `/file` keys remain valid.

No rows are backfilled, no tables are dropped, and no file objects are read, written, or removed by this migration. The existing Templates endpoints, artifact DTOs, permissions, and upload flow remain unchanged. Legacy `templates` records and `nuclei-templates` objects stay available for the later import batch.

Apply through `task migration:run` against the intended local database first. The migration runs in TypeORM's normal transaction, so other sessions see either the old pair of constraints or the new pair. PostgreSQL must validate existing artifact rows while acquiring the table lock; schedule production deployment accordingly and retain a database backup.

## Rollback

Before any new template artifact has been written, `task migration:revert` restores the prior source and object-key constraints without changing existing upload/agent rows.

After template artifacts exist, a database downgrade is intentionally blocked by the prior source constraint. The failed revert rolls back transactionally, preserving both the migration record and the new constraints. Do not delete templates merely to force a downgrade. Export or migrate their data in an approved maintenance procedure first. Reverting the application image alone does not require reverting these permissive constraints.

## Local validation

Use `task api:test:e2e:one SPEC=test/template-artifact-revisions.e2e-spec.ts` against disposable Docker PostgreSQL. It verifies canonical keys, source restrictions, cross-workspace and cross-file rejection, traversal, malformed revisions, and unchanged upload/agent final-key support. Run `task migration:run`, `task migration:revert`, then `task migration:run` for the upgrade/rollback rehearsal; also verify a revert refuses a seeded template row and retains that row.

Subsequent runtime and UI batches must validate quota deltas, pointer publication, concurrent edits, abandoned revision cleanup, legacy imports, dispatch authorization, and desktop/mobile browser flows before enabling template artifact writes.
