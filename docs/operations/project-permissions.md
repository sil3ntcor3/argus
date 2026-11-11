# Project permissions and legacy groups

`project.read` and `project.write` are the canonical permission keys for Projects.
The legacy `group.read` and `group.write` keys remain valid with exactly the same
actions. The permission catalog exposes both spellings, with legacy descriptions
on the group entries. Existing permission groups require no data migration.

Membership resolution adds the corresponding alias to each held read/write key.
The same resolved keys feed HTTP guards, the console's current-permission response,
and checks for granting individual permissions or assigning whole groups. Stored
permission arrays retain their original spellings. Other resource names, unknown
actions, and the global `*` wildcard retain their existing behavior.

The existing access rule that write permits read remains in place. Delegation
continues to require the exact held action: a member holding only `project.write`
can access a read endpoint, but cannot grant `group.read` or `project.read` unless
they also hold that action. Read access never grants write access. Aliases do not
bypass workspace membership, authentication, or owner/system-group protections.

This foundation prepares the Projects API while retaining `/api/asset-group` and
the current Groups console pages. No database schema or API response shape changes
are required. To roll back the application, retain legacy keys on roles that must
work with older versions; older versions do not recognize project-only grants.

Validation covers alias access and delegation in the workspace service and
`core-api/test/project-permissions.e2e-spec.ts`, including read-only rejection,
cross-workspace denial, whole-group assignment, and unchanged stored arrays.
