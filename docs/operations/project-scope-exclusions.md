# Scope exclusions for removed assets

The private `excludeMatchedScopeAssets` helper prepares durable removals from
rule-based scope. It requires an active caller-owned transaction, locks the owned
project and normalizes/deduplicates candidate UUIDs before writing anything.

Only owned assets currently selected by the saved include/exclude rules receive
new asset exclusions. Existing exclusions, foreign/missing assets, empty input and
scopes without includes add nothing. The helper returns the number of exclusions
actually inserted. The helper leaves membership rows unchanged. Legacy
`DELETE /api/asset-group/:id/assets` validates the entire requested batch, writes
needed exclusions, and removes memberships in one transaction under the same
project lock. Later synchronization cannot re-add those excluded assets.
Manual members remain untouched by rule synchronization until explicitly removed.

The project lock serializes competing calls. Candidate IDs use one bound UUID
array and a set-based insert, including batches exceeding 65,535 IDs. Caller
rollback undoes the exclusions. Saved exact asset exclusions also compile into
one UUID-array predicate, keeping repeat exclusions and synchronization within
PostgreSQL's bind limit after large matching removals.
Synchronization materializes the selected set once per statement, avoiding
repeated evaluation of a large exclusion array for each existing member.
Legacy duplicate/missing-member responses, tenant checks and messages remain
unchanged. Trusted internal calls that omit a workspace retain support for
historical projects without one; those cannot generate workspace-scoped exclusions.
Discovery integration follows separately.

Run `task api:test:e2e:one SPEC=test/project-scope-exclusions.e2e-spec.ts` against
the disposable local Docker database. Also run
`task api:test:e2e:one SPEC=test/project-membership-remove.e2e-spec.ts` for lock,
rollback, validation and durable-removal coverage. A code rollback does not delete
saved exclusions; inspect the project's rules before restoring removed membership.
