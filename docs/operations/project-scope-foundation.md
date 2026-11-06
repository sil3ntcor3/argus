# Private project scope rules

The `project_scope_rules` table prepares upstream project scope management.
Each rule belongs to one project, with an indexed UUID foreign key that cascades
on project deletion. Rules store include/exclude mode, target/hostname/CIDR/asset
kind and a string value. Rule UUIDs and timestamps use the existing entity defaults.

This foundation adds no endpoint or response field. Existing project/group
operations, manual membership, workflows and worker dispatch remain unchanged.
No rules are inferred from old groups, and automatic matching is not activated.
Value validation, tenant-scoped scope management and discovery follow separately.

Generate the migration through `task migration:generate name=AddProjectScopeRules`.
Back up the local database, review the generated statements, then apply with
`task migration:run`. The inverse migration drops only the new rule table/index
and foreign key. Back up rule data before any rollback after scope features are
activated. Validate upgrade/rollback/reapply using a disposable local database.
