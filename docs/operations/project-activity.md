# Canonical project activity

Canonical project create, update, scope replacement and delete requests emit
`project.created`, `project.updated`, or `project.deleted`. All three are audited
and listed in the workspace audit action dictionary. Legacy `/asset-group`
routes continue emitting `asset_group.created` and `asset_group.deleted`, and
historical group events remain readable.

Events carry the authenticated actor, request workspace, project resource ID,
and `workspace:<workspaceId>/project:<projectId>` subject. Updates use the
upstream `ProjectChange` discriminator. Scope success records numeric added and
removed counts after the atomic writer completes; failed requests carry the
failure outcome without success counts. Read and anonymous requests emit none.

The optional internal `resourceIdFromRoute` decorator setting identifies
message/count-only responses. Explicit result ID extractors take precedence;
handlers that do not opt in retain their previous attribution behavior.
Discovery attachment reporting, project workflow activity, and archive actions
follow in separate upstream batches. No schema or REST response changes.
