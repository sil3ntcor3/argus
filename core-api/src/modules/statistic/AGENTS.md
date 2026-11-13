# Argus statistics module

`StatisticService` assembles dashboard counts, timelines, geo and TLS breakdowns, and ranked lists. `StatisticCronService` writes daily snapshots under a Redis lock. The read-only routes under `/api/statistic` use `workspace.read` and the selected workspace, including `asset-locations`.

- Report-specific finding queries reuse the open-finding predicate where they present actionable counts. Keep historical discovery counts distinct from open finding totals.
- Workflow start/end signals are in process. Discovery completion can publish `workflow.run.completed` through the event bridge. Use the same run workspace when invalidating cached statistics or emitting events.

Use the statistics controller, service, and cron specs. Validate dashboard and location requests against local Docker with a workspace reader.

Finding trends and severity totals exclude pending/rejected proposals. Use
`findingDetectedAt` for discovery trends; storage creation filters and job/scan
dates retain their own semantics. Review queue size is a separate count.
