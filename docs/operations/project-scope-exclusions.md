# Scope exclusions for removed assets

The private `excludeMatchedScopeAssets` helper prepares durable removals from
rule-based scope. It requires an active caller-owned transaction, locks the owned
project and normalizes/deduplicates candidate UUIDs before writing anything.

Only owned assets currently selected by the saved include/exclude rules receive
new asset exclusions. Existing exclusions, foreign/missing assets, empty input and
scopes without includes add nothing. The helper returns the number of exclusions
actually inserted. It leaves every membership row unchanged; future removal
callers must validate the requested memberships and delete them in the same
transaction. Manual members remain untouched by later rule synchronization.

The project lock serializes competing calls. Candidate IDs use one bound UUID
array and a set-based insert, including batches exceeding 65,535 IDs. Caller
rollback undoes the exclusions. Saved exact asset exclusions also compile into
one UUID-array predicate, keeping repeat exclusions and synchronization within
PostgreSQL's bind limit after large matching removals.
Synchronization materializes the selected set once per statement, avoiding
repeated evaluation of a large exclusion array for each existing member.
Legacy mutation and discovery integration follow
separately; no production route invokes this helper yet.

Run `task api:test:e2e:one SPEC=test/project-scope-exclusions.e2e-spec.ts` against
the disposable local Docker database. Reverting this batch removes the helper,
tests and documentation and restores the previous compiler and sync queries.
