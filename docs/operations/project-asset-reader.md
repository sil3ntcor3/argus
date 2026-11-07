# Private project member reader

`ProjectAssetReadService.list` returns membership source/reason, target details,
project-linked open severity counts, and the latest project-attributed scoped
run. It selects the page before enrichment. Project, asset, label, and workflow
tenant boundaries are checked. Reads
never reconcile scope. Sorting is allowlisted, paging bounded, and values bound.
No public API or schema changes. Validate with `task api:test:e2e:one
SPEC=test/project-asset-read.e2e-spec.ts`; rollback deploys the prior image.
