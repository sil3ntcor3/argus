# Argus generic Issues

Issues are workspace work items with per-workspace counters, polymorphic links,
assignment, priority and explicit status/resolution. The old source columns and
comments remain for data compatibility. The legacy source queue/handlers and
legacy comment routes stay unregistered; CommentsService owns discussions.

- Reads/writes require workspace permissions. Resolve linked resources in the
  selected tenant with effective domain access. Standalone run ownership uses
  `findingRunWorkspaceCondition`, including mixed/orphan rejection.
- Mask generated remediation titles in both projection and search without
  vulnerability read access. Never return private proof or unrestricted users.
- Every issue/rule mutation takes `lockIssueWrites` before reading mutable
  state, then locks/reloads rows and applies explicit patches. Use statement
  timestamps in UTC after locks; transaction-start time can predate decisions.
- IssueAutomationService validates durable finding evidence and commits a
  private per-proof receipt with all actions. Transport/Redis identifiers are
  not authority. Preserve ordered parent/finding locks and current manual
  decision/expiry checks. Deleted issues do not erase proof receipts.
- Counters are serialized and never reused after deletion. Defaults are an
  explicit action. Immutable system comments cannot be edited/deleted.
- Never restore the old source-driven creation path alongside the issues lane.

See `docs/operations/generic-issues-rollout.md`. Run issue service/controller
specs and Docker storage/API/automation regressions after changes.
