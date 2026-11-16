# Project summaries and run context

This batch aligns project read views with Open ASM v0.12.1
(`961d77142671e90190bd97132638441e593bec47`). It preserves Argus branding,
existing launch and scheduling behavior, archived views, and merged extras.
There are no migrations, dependency changes, or background writers.

## Read behavior

- Project list rows add workflow counts and sanitized trigger summaries. Detail
  and write receipts keep their existing shape. Archived projects retain their
  saved definitions; their cards show **Triggers off**.
- Effective vulnerability readers receive open approved counts by severity and
  open findings first attributed to the project within the last 168 hours.
  Other readers receive nulls. Recorded project findings remain counted after
  an asset is removed from current membership. Fixed, archived, unapproved and
  actively dismissed findings are excluded; expired risk acceptances are open.
- `sortBy=risk` orders critical, high, then medium counts before pagination, with
  stable ID ties, and returns 403 without effective vulnerability read access.
  Normal list sorts remain available. The console keeps Name as its default and
  persists the chosen sort with search/status in the URL.
- Run trigger references must match the run's binding. Causal IDs and workflow
  names additionally require effective job read access and same-workspace,
  consistent provenance. Deleted or inconsistent references become null.
- Activity adds recognized event labels, historical risk-acceptance labels and
  bounded scalar audit changes for name, description, color and automatic
  membership. It exposes no raw metadata, instructions or scheduler identifiers.

The next scheduled time on a card is a browser estimate from enabled UTC cron
definitions, displayed in the viewer's timezone. It does not claim scheduler
health or change legacy binding schedules. Unsupported expressions keep their
Schedule badge but have no next-time estimate. **No enabled triggers** describes
the saved trigger definitions only; manual launch and legacy binding schedules
remain supported.

## Validation and rollback

Run `task lint`, `task test`, `task console:test:run -- --maxWorkers=2`, and the
project summary, run-reader, finding-provenance, trigger-provenance, archive and
finding REST Docker suites through the repository's Task entries. Check summary
counts, risk pagination and permission denials with disposable workspace data.
Check desktop/mobile cards, sort URL reload, run links, Activity and permission
revocation against the local Docker console. The summary suite is also exercised
with UTC and America/Chicago API process timezones.

Rollback uses the previous API/console images together. No data repair or schema
rollback is needed. Cache entries can contain prior response fields, so the console
also gates sensitive counts and causal links using current effective permissions.
