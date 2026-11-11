# Canonical membership removal foundation

The private `ProjectAssetsService.remove` normalizes and deduplicates UUIDs,
authorizes the project under the shared scope lock, and removes only memberships
whose assets belong to the same workspace. Empty selections still authorize the
project; absent or foreign selections count as zero. Assets themselves remain.

Before deletion, assets still selected by saved scope rules receive durable exact
exclusions in the same transaction. Subsequent synchronization cannot immediately
re-add those members. Repeated and competing removals create no duplicate
exclusions. Deletion or transaction failure rolls back both changes.

The count uses actual PostgreSQL returned rows, including TypeORM's structured
DELETE result. This foundation adds no endpoint or event. Canonical DELETE and
its request activity follow separately; existing group removal keeps its strict
missing-membership errors. Manual addition behavior is unchanged.
