# Scope-rule membership index

`project_assets.scopeRuleId` has the nonunique B-tree index
`IDX_pa_scopeRuleId`. PostgreSQL uses it when deleting scope rules and clearing
their membership references through the existing `ON DELETE SET NULL` foreign
key. Without this index, deleting many saved rules repeatedly scans memberships.

The generated `IndexProjectAssetScopeRule` migration only creates this index;
its rollback only drops it. Columns, foreign keys, source values, memberships,
assets, and API responses remain unchanged. Null references are still allowed.

Before deployment, take a database backup and schedule the migration for a quiet
period: a regular index build temporarily blocks writes to `project_assets`.
Run `task migration:run` from the repository root using the intended database
configuration. Check that `IDX_pa_scopeRuleId` is valid and ready afterward.
Only use `task migration:revert` when this migration is the latest applied one;
rollback restores the previous schema and its slower rule cleanup behavior.

The focused PostgreSQL regression is
`task api:test:e2e:one SPEC=test/project-scope-index.e2e-spec.ts`. It checks the
physical index and ORM metadata, then removes 65,536 saved rules while retaining
all assets, membership rows, and manual/rule source values. Its fixtures are
rolled back in one transaction. Run it only against a disposable local database.
