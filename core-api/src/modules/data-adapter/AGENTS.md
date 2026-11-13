# Scan result ingestion

`DataAdapterService.syncData` routes the result by job category. The job-result
processor calls it only when the job saves data and has a parsed or structured
payload. Integration connectors can call `upsertAssetsByTargetId` directly.

- Asset identity is `(value, targetId)`; service identity is `(assetId, port)`.
  Port observations are run history. DNS and HTTP facet tables support queries
  that would otherwise have to inspect raw results.
- Findings deduplicate by fingerprint, derived from the finding name, asset
  and tool. Repository findings also use the connector fingerprint when
  present. Changing the host formula would split existing findings.
- The adapter removes supplied `detectionStatus`, `timesDetected`,
  `resurfacedCount`, `missedScans`, `fixedAt`, and `lastScannerObservedAt`.
  Resolution run references, fix-claim actor/date, their relation objects and
  `dueAt` are also server-owned and stripped before insertion.
  Adding a private finding column also requires updating this exclusion list:
  `select: false` controls reads and does not prevent result-payload inserts.
  It takes scope only from the claimed job. Preserve stored enrichment when a
  repeat scan omits it.
- `finding-scanner-sightings.ts` locks provenance parents before findings, and
  the upsert takes finding locks in fingerprint order. The unique scanner
  source per finding and run prevents repeat deliveries from inflating counts.
  Every positive still updates the private database observation time under
  those locks. Preserve the lock order and the insert chunk limit.
- A fixed finding resurfaces only with a recorded in-progress scan claim later
  than the uniquely verified private negative-scan cutoff, falling back to the
  fix timestamp for ambiguous/invalid legacy events. Keep timestamp parsing and
  comparisons in PostgreSQL; JavaScript dates lose microseconds. Archive status is preserved. This path records
  observed findings; an omitted finding does not close anything.

Test with `task api:test:one SPEC=src/modules/data-adapter/data-adapter.service.spec.ts`.
Validate lock order, retries, and timestamp comparisons against local Postgres
when changing scanner lifecycle behavior.

Review/discovery status, reviewer ID/relation, review date and note are also
server-owned and stripped from connector results. `select: false` alone cannot
protect these columns from an ingestion payload.

Scanner detection/resurfacing bridge events are published only after the ingestion transaction commits. Include exact durable finding event IDs; never infer resurfacing from payload status or publish uncommitted proof.
