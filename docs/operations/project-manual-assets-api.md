# Add assets to a project

`POST /api/projects/:id/assets` accepts `{ "assetIds": ["uuid"] }` with at most
1000 unique UUID strings. It requires `project.write` (or the compatible
`group.write`) in the selected workspace. The 201 response contains `message`
and `count`; the count covers newly inserted memberships only. Empty requests
still check project access. Malformed arrays return 400; foreign or missing
projects/assets return 404 without partial writes.

Existing rule-selected members become manual and survive later rule removal.
Promotions and repeated manual selections count as zero new memberships. The
current group API continues to reject duplicate memberships.

After commit, nonempty additions publish `project.assets.added` with canonical
project/workspace attribution and new asset IDs. Publishing uses the existing
best-effort bridge and does not undo a committed addition. Request activity is
`project.updated` with `change: assets.added`, the user and numeric added count.
The [membership foundation](project-manual-assets.md) owns tenant validation,
normalization and shared scope locking. No scanner is executed by this request.
