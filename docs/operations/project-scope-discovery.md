# Project discovery attachment

The internal `ProjectScopeDiscoveryService.addDiscoveredAssets` foundation accepts
a workspace and discovered asset IDs. It selects only active projects with
`autoAddAssets` enabled and saved scope rules. The
[project event consumer](project-discovery-events.md) now handles discovery
batches and reports committed memberships. Scan/integration producers follow
separately.

All affected project rows are locked in UUID order in one transaction, sharing
the lock used by scope replacement and manual membership changes. Rules are read
after locking. The SQL matcher applies includes and exclusions only to the
supplied assets owned by the workspace. Existing manual or rule memberships are
preserved; returned IDs describe newly inserted rule memberships only. A failure
on any project rolls back the whole batch, so retry cannot lose a partial report.

Validation covers tenant isolation, disabled/archived projects, exclusions,
manual provenance, retry deduplication, concurrent delivery, rollback, and a
preference change held behind a real PostgreSQL lock. No schema or API changes.
