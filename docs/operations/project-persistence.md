# Project persistence foundation

This first persistence batch from upstream open-asm #819 renames the physical
Groups tables and their join columns in place:

| Previous table          | New table           | Column rename                |
| ----------------------- | ------------------- | ---------------------------- |
| `asset_groups`          | `projects`          | None                         |
| `assets_group_assets`   | `project_assets`    | `assetGroupId` → `projectId` |
| `asset_group_workflows` | `project_workflows` | `assetGroupId` → `projectId` |

The Argus Groups UI, `/api/asset-group` routes, JSON properties, `assetGroup`
filter, `group.read`/`group.write` permissions, audit actions and BullMQ queue
names retain their existing contracts. Row IDs, timestamps, workflow bindings,
schedules and repeat-job keys are preserved. Provenance tracking and the Projects
UI will follow in separate batches.

## Upgrade and rollback

1. Take a verified database backup. Stop all API replicas and schedule consumers
   that access Groups persistence; old and new API images require different table
   names and must not run together during this upgrade.
2. Apply the reviewed migration with `task migration:run`, then start the updated
   API image. The standard Docker migration service gates API startup.
3. Check Groups list/detail counts, selected/available assets, asset-group filters
   and workflow bindings. Confirm existing schedule IDs and repeat-job keys resolve.
4. For rollback, stop the updated API first. If this is the last applied migration,
   run `task migration:revert`, then start the previous API image. The reverse
   renames preserve rows and relationships; retain the backup until verified.

The [generated migration](../../core-api/src/database/migrations/1793921060254-RenameAssetGroupsToProjects.ts)
was reviewed to replace new-table creation with renames and remove unrelated
TypeORM drift. Existing workflow-FK nullability is retained. Applied migration
history is immutable.

## Regression checks

Run `task api:test:one SPEC=src/modules/asset-group/asset-group-asset.service.spec.ts`,
`task api:test:e2e:one SPEC=test/asset-group-persistence.e2e-spec.ts`, and
`task api:test:e2e:one SPEC=test/assets-filter.e2e-spec.ts` against local test
infrastructure. The compatibility suite checks the existing endpoints, relation
properties, selected/available assets, run scope and workspace isolation without
dispatching a scan.
