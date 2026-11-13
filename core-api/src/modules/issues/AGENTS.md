# Argus issues module

`IssuesService` tracks workspace issues linked to vulnerability sources. It owns issue status, source lookup, and issue comments. The existing HTTP issue routes use workspace read/write permissions.

- Resolve the source and issue in the selected workspace before returning or changing related records. Status changes and comments must check the same workspace. Comment edits and deletion also enforce authorship.
- Background creation uses a source handler and checks for an existing issue before creating another. Preserve the linked finding and existing source semantics when extending issue types.
- The internal `IssueComment` class now maps to `comments`. Exactly one issue
  or finding subject is stored; finding ownership is private in this storage
  foundation. Legacy issue queries and reply joins must stay issue-scoped.
  Never pass a null issue ID to TypeORM's legacy assistant lookup.
- The table rename requires a coordinated API rollout. Rollback refuses while
  finding comments exist. See `docs/operations/resource-comment-storage-rollout.md`.

Use issue service and controller specs for authorization, source handling, and comments.
