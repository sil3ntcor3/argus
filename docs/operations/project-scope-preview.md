# Internal project scope preview

Preview validates references, counts the include-selected set after exclusions,
and unions that set with the project's manual members. Overlap counts once;
exclusions do not remove manual members. Exclusion counts show how many include
matches they remove; exclusions alone select no rule assets.

Per-rule counts retain original input indices even when canonical rules duplicate.
An optional project must belong to the workspace. Every asset query, including
manual membership, rechecks target ownership so malformed historical foreign
links do not affect counts. Preview does not change those links or save rules.

The calculation is internal; public preview DTOs, request limits and the
`POST /projects/scope-preview` endpoint follow separately. No schema or dependency
changes are required.
