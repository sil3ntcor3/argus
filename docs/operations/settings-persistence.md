# Private settings persistence

This is the persistence foundation from upstream open-asm #811
(commit 668e35606b275f5495952027e079ed67ddab6066), adapted for Argus.
It adds a non-null JSONB settings column with an empty-object default to
system_configs and workspaces. Existing rows receive the same default.
No feature settings API or UI is enabled by this batch.

## Storage boundary

Settings are section-keyed objects. System and workspace settings are independent.
TypeORM excludes them from normal entity reads; internal code must explicitly
select the column when needed. Swagger hides both properties. Existing request
DTOs do not accept settings, and existing configuration responses stay unchanged.
The TypeScript aliases describe internal values, not a validated public contract.
The database enforces non-null JSONB, not the shape of each feature section.
Do not place credentials in this unencrypted store.

## Local validation

1. Use a disposable local PostgreSQL database and Redis. Verify the database host,
   port and name before running any migration task. Override connection variables
   for the test database; do not point these checks at a shared environment.
2. Run task migration:run to replay existing migrations. For an upgrade rehearsal,
   first use the previous application version to create a workspace and system
   configuration before applying the new migration.
3. Run task api:test:e2e:one SPEC=test/settings-persistence.e2e-spec.ts against the
   disposable services. E2E_POSTGRES_DB must name a database ending in _test.
   The suite verifies defaults, nested round trips, isolation, null rejection,
   default-query privacy, creation responses and existing request filtering.
4. Run task lint, task test, task console:test:run and task api:build from the
   repository root. Rebuild the API Docker image and verify sign-in, workspace
   configuration and platform administration in the browser.
5. Compare the live generated OpenAPI document to the tracked document. This
   persistence-only change must not add properties or endpoints to the contract.

The migration was generated with task migration:generate name=AddSystemConfigSettings.
Unrelated index, constraint and nullability drift was removed from the newly
generated file during review; only the two settings columns remain.

## Rollback

The previous application version can run with the additive columns present.
Prefer rolling back the application while retaining the schema and saved values.
For a schema rollback, confirm that AddSystemConfigSettings1793772490708 is the
last applied migration, then use task migration:revert against the intended local
database. It drops both settings columns and permanently deletes their values.
Back up any values first if they need to survive. Existing workspace and system
configuration records remain. Reapplying with task migration:run restores empty
objects; it cannot recover deleted settings.
