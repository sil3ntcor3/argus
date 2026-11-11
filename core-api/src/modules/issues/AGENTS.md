# Argus issues module

`IssuesService` tracks workspace issues linked to vulnerability sources. It owns issue status, source lookup, and issue comments. The existing HTTP issue routes use workspace read/write permissions.

- Resolve the source and issue in the selected workspace before returning or changing related records. Status changes and comments must check the same workspace. Comment edits and deletion also enforce authorship.
- Background creation uses a source handler and checks for an existing issue before creating another. Preserve the linked finding and existing source semantics when extending issue types.

Use issue service and controller specs for authorization, source handling, and comments.
