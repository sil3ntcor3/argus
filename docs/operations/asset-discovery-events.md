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

`TargetsService.createMultipleTargets` also publishes the initial assets after
the target transaction commits, using the UUIDs assigned before insertion.
Each domain or IP target has one asset batch; CIDRs have one batch containing
their expanded IP assets. Existing target-created scheduling events run first.
Git organization targets create no initial assets and publish no discovery.
Validation errors, duplicates and rolled-back transactions publish nothing.
These initial assets have no originating run ID. Ownership checks, CIDR policy,
chunked inserts and primary flags are unchanged. No scans are started by the
discovery report itself; it lets the project consumer attach matching assets.

Explicit scope-edit reporting follows separately.
