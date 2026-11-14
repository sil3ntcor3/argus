# Target enrichment and fixed activity

This read-only Open ASM v0.12.1 port adds context to Argus target rows and recent fix information to Overview and Activity. Existing target filters, pagination, totals and internal target reads retain their behavior. No migration or data backfill is needed.

## Access and response semantics

GET /api/targets enriches only the selected page. Effective vulnerability readers receive approved open finding counts by severity; job readers receive target-specific settled/total job counts across active runs; project readers receive at most six active workspace projects containing the target’s assets. Each domain is gated independently. Unauthorized fields are null, authorized empty counts are zero, and authorized empty project lists are empty arrays. An idle target has null scan progress. The response is private and non-cacheable.

Next-scan times come from the saved BullMQ scheduler identity and matching cron, never a computed cron estimate. A disabled, missing or mismatched schedule, unavailable Redis, or an exhausted lookup deadline yields null. Eight lookups run concurrently, sharing Overview’s timeout and outstanding-command limit; a stalled queue cannot serialize a full page behind Redis. SQL enrichment remains available when scheduling metadata is unavailable.

The console keys target queries by the relevant permissions and hides prior enrichment while permissions refresh or access is denied. Project links open the project without invoking the target row action. Long target names are truncated within the mobile header while retaining the existing desktop width.

## Fixed findings and time

Overview’s nullable fixedVulnerabilities counts approved findings that are currently fixed and have a recorded fixedAt in the preceding 168 elapsed hours, including the present instant. A dismissal or archive alone is not a fix. Without finding access the count is null.

Changes accepts kind=fixed and includes distinct fixed entries in its mixed feed. Fixed entries use the stored absolute fixedAt, exclude future/null timestamps and pending/rejected proposals, and remain separate from original finding discoveries. The same finding ID can appear once for discovery and once for its current fix; clients must key by both kind and ID. An explicit fixed filter without finding access returns 403; a mixed feed omits all finding entries.

Legacy asset, service and fallback finding discovery columns have no timezone. Reads interpret them in the API process’s IANA timezone before combining them with timestamptz detection/fix values. Recorded absolute first-detection/fix instants are preserved. Historical timestamps within a repeated daylight-saving hour cannot recover a missing original offset. Seven-day metrics use elapsed hours so a daylight-saving transition cannot expand the window to 169 hours.

## Validation and rollback

Run `task test`, `task lint`, `task console:test:run -- --maxWorkers=2`, and the Docker target enrichment, Overview, Changes, summary and run-history e2e suites. The enrichment suite exercises scope/permission combinations, expired risk acceptance, proposal exclusion, pagination, recorded schedules and a real Postgres daylight-saving boundary. Browser checks cover desktop/mobile target rows, project navigation, fixed Activity filtering and permission revocation.

Deploy the API and regenerated spec/client together. Rollback consists of restoring the previous API and console images; this batch changes no storage or writers. Fixed Activity is a view of current fix state, not a full immutable history of every fix/resurfacing transition.
