# Transactional project scope synchronization

The private `syncProjectScope(manager, projectId, workspaceId)` helper prepares
upstream scope synchronization. No HTTP route, discovery hook, scheduler or legacy
mutation calls it in this batch.

The caller must own an active TypeORM transaction. The helper locks the owned
project row, resolves its UUID and loads the saved rules in creation/ID order.
It selects only assets belonging to that workspace, removes obsolete rule-source
members, repoints retained rule members to the first matching include rule, and
adds missing members. Manual memberships remain untouched, including excluded
manual assets. Empty or exclusion-only scopes remove only rule-source members.

The returned `added` IDs contain actual insertions; `removed` counts actual
deleted memberships using TypeORM's PostgreSQL DELETE result shape. Concurrent
syncs share the project lock, and caller rollback undoes the complete change.
Future rule, discovery and manual-membership mutators must use the same lock;
their activation and archive guards follow separately.

Run `task api:test:e2e:one SPEC=test/project-scope-sync.e2e-spec.ts` against the
disposable local Docker database. Tests cover provenance, exclusions, tenant
boundaries, rollback, eight competing syncs, idempotency and transaction ownership.
Reverting this preparation removes only the unused helper and its tests/docs.
