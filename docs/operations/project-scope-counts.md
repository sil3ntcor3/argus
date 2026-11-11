# Saved scope match counts

Saved scope reads batch exact asset exclusions through one workspace-scoped UUID
array query. Each exclusion still receives its own include-match count, including
duplicate UUIDs with different casing. Other exclusions retain individual counts;
one exclusion does not reduce another exclusion's reported matches.

An include plus 65,536 asset exclusions uses two match-count queries. Empty and
exclusion-only scopes issue none. The single-asset exclusion path is retained.
Labels and membership-source counts remain scoped to the project workspace.

Run `task api:test:one SPEC=src/modules/projects/project-scope-counts.spec.ts` and
`task api:test:e2e:one SPEC=test/project-scope-counts.e2e-spec.ts` against the local
Docker database. The latter verifies a stored 65,536-exclusion scope, tenant-safe
labels and a bounded total query count. No response, schema or dependency changes
are required. Reverting this optimization restores individual count queries.
