# Bulk scope test fixtures

The scope index and exclusion regressions insert 65,536 assets at once. The
index regression rolls its fixture transaction back afterward. Auto-analyze
cannot reliably update planner statistics between fixture population and the
per-row foreign-key checks used to insert memberships.

Both tests run `ANALYZE assets` after their bulk asset insertion. This refreshes
statistics for the fixture's actual cardinality without forcing a query plan or
changing the schema, assertions, or test timeout. Run these tests against a
disposable local database, as with the other PostgreSQL integration tests:

```bash
task api:test:e2e:one SPEC=test/project-scope-index.e2e-spec.ts
task api:test:e2e:one SPEC=test/project-scope-exclusions.e2e-spec.ts
```
