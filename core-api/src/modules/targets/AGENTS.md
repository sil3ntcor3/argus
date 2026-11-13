# Argus targets module

Targets are scan roots such as domains, IP addresses, CIDRs, and Git organizations. The service owns workspace validation, the initial assets, discovery schedules, and repository settings. Creating a target emits a local event for discovery workflow selection.

- Target reads use `target.read`. Overview and Changes also require `asset.read`. Run History also requires `job.read`. Conditional finding, run, and project data in Overview uses the corresponding effective permissions.
- `TargetOverviewService`, `TargetRunHistoryService`, and `TargetChangesService` own separate read models. Share run membership and whole-run status logic through `target-run-sql.ts`. The same job can contribute to a run that covers multiple targets, so compute target-specific counts separately.
- Keep the 30-day stale rule in `stale-target-condition.ts` shared by filters, totals, and insights. The Changes feed sorts discoveries by original timestamp and retains historical finding discoveries for permitted readers.
- A target schedule stores the BullMQ scheduler key. A missing scheduler or unavailable Redis can leave the next scan unknown. Preserve cancellation permissions and avoid treating a closed run as active.

Run the target service and controller specs and validate summary, overview, changes, and run history against local Docker Postgres.

Finding discoveries, weekly buckets and per-run finding totals exclude
pending/rejected proposals. Approved AI findings use their human approval's
detection time, without acquiring scanner-run provenance.

Overview issue references require workspace access and scoped resource links. Mask generated finding titles without finding permission and limit results to five current open/in-progress issues.
