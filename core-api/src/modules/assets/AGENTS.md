# Argus assets module

This module serves the workspace attack-surface read models. `assets` stores hosts under targets, and `asset_services` stores observed services. Scan ingestion and facet persistence live in `data-adapter`.

- The Assets list and facet endpoints use `asset.read`. Mutations such as rescans, tags, and enabling assets use `asset.write`. Keep reads scoped through the asset's target and workspace.
- `asset-filter.ts` compiles the filter tree and supports legacy query parameters. Preserve the distinction between a host row and a service row when joining or counting. `fresh-runs.ts` defines new discoveries for the fresh-run filter.
- The asset graph endpoint provides host/service topology and lazy service expansion. The console lays out clusters independently. Export uses the same workspace and filter semantics as the read view.
- `UrlDiscoveryService` runs URL discovery and reports completion through the event bridge. The results describe observations that can be used in later workflows.

Use the asset filter, service, and controller specs. Use the Docker asset facet and filter integration specs when changing aggregation or scoping.
