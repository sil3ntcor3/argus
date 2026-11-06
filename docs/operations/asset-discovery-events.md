# Committed asset discovery batches

`DataAdapterService.upsertAssetsByTargetId` publishes one `asset.discovered`
batch after committing new asset rows and DNS facets. It supplies the actual
target workspace, target ID, newly observed asset IDs and optional originating
run ID. Scan subdomain ingest and integration DNS refreshes share this path.

The pre-write lookup uses a bound array of values. DNS refreshes can return both
inserted and updated identifiers, so pre-existing values are excluded from the
event. Existing DNS merge/replacement behavior, enablement, first-run provenance
and upsert return counts are preserved. Empty, failed or unattributable batches
emit no event. A refresh of existing rows alone is not a discovery.

The [project consumer](project-discovery-events.md) can now attach these assets
to matching active projects. Concurrent ingests may publish the same discovered
ID; membership attachment and reporting deduplicate existing memberships.
Publishing retains the existing best-effort bridge limitation after commit.
Initial target/CIDR assets and explicit scope-edit reporting follow separately.
