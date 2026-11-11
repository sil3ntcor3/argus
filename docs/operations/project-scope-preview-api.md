# Project scope preview API

`POST /api/projects/scope-preview` requires an authenticated workspace member with
`project.read` (the existing `group.read` alias also works). It returns HTTP 200
with `{total, ruleAssets, perRule}` without saving rules or changing membership.

Send `{rules: [{mode, type, value}], projectId?}`. Modes are `include`/`exclude`;
types are `target`, `asset`, `hostname`, or `cidr`. Rules are limited to 100 and
values to 255 characters. The optional project ID must be a non-null UUID owned
by the workspace. Invalid input/reference values return 400; missing or foreign
projects return 404; authentication and membership boundaries remain 401/403.

Counts retain original input indices after normalization and deduplication.
Manual members are included once even when rules overlap or exclude them.
See [calculation semantics](project-scope-preview.md). No schema or dependency changes.
