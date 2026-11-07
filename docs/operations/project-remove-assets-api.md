# Remove assets from a project

`DELETE /api/projects/:id/assets` accepts `{ "assetIds": ["uuid"] }` with at
most 1000 unique UUIDs and requires `project.write` or compatible `group.write`.
The 200 response contains `message` and `count` of removed memberships. Missing
or foreign candidates count as zero; invalid arrays return 400. Unauthenticated
requests return 401, read-only requests 403, and missing projects 404. Empty
selections still check project access.

Removal atomically excludes assets still matched by rules and deletes their
memberships under the shared scope lock. Repeats are idempotent, and rule sync
cannot re-add removed members. Assets and other members stay. Legacy group
removal retains strict missing-membership errors.

User activity is `project.updated` with `change: assets.removed` and a numeric
removed count after commit. Failed requests contain no success count. Removal
emits no `project.assets.added` fact. The [foundation](project-remove-assets.md)
describes workspace filtering and rollback behavior.
