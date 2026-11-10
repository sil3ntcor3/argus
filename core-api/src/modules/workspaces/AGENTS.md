# Argus workspaces module

This module manages workspace membership, invitations, permission groups, workspace settings, and MCP key rotation. `WorkspacesService` supplies the membership lookup for `WorkspacePermissionGuard`. `permission-catalog.json` lists grantable permission keys and ships with the API image.

## Tenant access

- `@WorkspaceAccess` checks membership and the union of a member's group permissions. `*` grants all keys and a resource's `write` implies its `read`. Preserve the project compatibility aliases when changing project permission checks.
- The guard resolves the workspace from `:workspaceId`, a configured `workspaceParam`, the header or `wid` cookie, then a generic `:id` route parameter. `@WorkspaceId()` reads the header or cookie only. Match the guard's source to the service's source on workspace detail routes.
- Invalid workspace IDs return 400. A nonmember gets 403. A session by itself establishes identity. Apply a workspace guard to enforce tenant access.
- Workspace creation adds owner membership and its wildcard permission group in one transaction. The five-workspace limit counts owned workspaces. Archive flags control active lists while preserving data.
- Permission changes and deletion use direct audit writes where they must commit with the mutation. Workspace deletion clears targets, removes the workspace, then starts private artifact cleanup after commit. The audit row survives the cascade and can authorize later retries.

Use `task api:test` for permissions and workspace service checks. Run `task api:test:e2e:one SPEC=test/workspaces.e2e-spec.ts` against local Docker for lifecycle behavior.
