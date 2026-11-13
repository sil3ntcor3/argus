# Argus audit module

`AuditService` owns the workspace audit trail, query cursors, direct writes, and privacy cleanup. `audit-events.controller.ts` exposes `/api/workspaces/:id/audit`, `/actions`, and `/export` under `audit.read` for the route workspace. The list orders by `occurredAt DESC, id DESC`. Export neutralizes spreadsheet formulas, caps the result at 10,000 rows, and records a successful `audit.exported` action.

## Writes and retention

- A controller normally publishes a cataloged event. `AuditSink` persists the actions enabled by `EVENT_POLICY`, deduplicated on `eventId`. Add audit actions to `AUDIT_ACTION_CATALOG`, the event catalog, and the policy together. The wiring specs check that the three agree.
- Use `recordInTx` for a change and its audit record that must commit together. Do not decorate the same action with `@PublishEvent`, which would generate a second audit row. `auditSafely` handles best-effort writes in its own transaction.
- `audit_events` has no workspace or actor foreign keys. A workspace deletion record survives the cascade and is used to authorize retried storage cleanup. Keep the action, resource ID, workspace ID, and outcome accurate.
- Postgres blocks modification of existing rows except the transaction-local privacy and retention maintenance paths. Those require a superuser or membership in `audit_maintenance`. The privacy sweep pseudonymizes by actor ID across workspaces and can remove the target user ID from the member removal record.
- The daily retention job archives rows older than 90 days to per-day JSONL files under `AUDIT_ARCHIVE_DIR` before deleting any rows. The watermark resumes archival. File or watermark failures stop deletion. Keep the archive and its watermark private.

Run `task api:test` for query, CSV, retention, and wiring checks. Verify trigger and permissions changes against a disposable local Postgres instance.

Review metadata projection uses `vulnerability-review-audit.ts`: single/merge
events identify the proposal, bulk receipts identify actual reviewed/skipped
IDs, and absent receipts leave outcomes unknown. Never record review notes or
attached request/response evidence in audit envelopes.
