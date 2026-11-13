# Finding resolution storage

This v0.12.1 foundation adds five nullable private columns to `vulnerabilities`:
`lastSeenJobHistoryId`, `fixedByJobHistoryId`, `fixClaimedAt`, `fixClaimedById`,
and `dueAt`. The two run references and the user reference use `ON DELETE SET
NULL`, preserving the finding and its dates if the referenced record is deleted.
Dates use PostgreSQL `timestamptz`.

The migration is generated with
`task migration:generate name=AddFindingResolutionProvenance`. It contains only
these five columns and three foreign keys. It adds no indexes or backfill.
Existing rows remain unchanged and the new fields are null. Ordinary entity
reads and the public API omit these fields, including when privately populated.

There are no runtime writers, automatic closure, fix verification or SLA changes
in this batch. Existing scanner evidence, dismissals, timeline behavior and
legacy archive fields remain in place. Later feature batches will define their
public contracts separately.

Before deployment, back up PostgreSQL and apply migrations through the existing
deployment migration service. The old application remains compatible with the
additive schema. A rollback using `task migration:revert` removes only the five
new columns and their foreign keys. Once later writers exist, export their data
before reverting; rollback discards values in these new columns.

Validation covers disposable local Docker PostgreSQL up/down/up with a preserved
finding, null defaults, invalid references, deletion retention, timezone
round-trips, and authenticated list/detail privacy. Desktop/mobile Docker browser
regressions exercise the existing Templates, Files and project AI flows.
