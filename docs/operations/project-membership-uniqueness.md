# Unique project memberships

`UQ_pa_projectId_assetId` enforces one row per project/asset pair. The legacy
membership endpoint still returns 400 for existing pairs; concurrent duplicates
now return 400 too. Other database failures retain their existing handling.
The array save remains transactional, so a duplicate cannot leave a partial batch.
The same asset may belong to multiple projects. Tenant checks remain unchanged.

The migration creates the unique index and does not delete historical rows.
Before deployment, inspect duplicate pairs with this read-only query through the
repository Task/database workflow:

```sql
SELECT "projectId", "assetId", COUNT(*)
FROM project_assets
WHERE "projectId" IS NOT NULL AND "assetId" IS NOT NULL
GROUP BY "projectId", "assetId" HAVING COUNT(*) > 1;
```

If duplicates exist, index creation fails transactionally and leaves them intact.
Back up and review those rows before resolving them; automatic deletion could
discard custom provenance. Rollback drops only the index and preserves all data.
Generate development migrations only with
`task migration:generate name=AddProjectAssetUniqueness`, review the output, then
validate `task migration:run` / `task migration:revert` / reapply locally.
