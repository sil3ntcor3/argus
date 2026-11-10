# Argus auth module

`auth.ts` creates the better-auth instance with Postgres and Redis. `AuthModule.forRoot()` mounts `/api/auth/*` and discovers the `@Hook()` providers. The user, session, account, and verification entities are in this module. `session-storage.ts` provides Redis-backed session storage.

## Request and account flow

- The global `AuthGuard` reads the session and copies any refreshed `Set-Cookie` onto the response. It attaches the session and user to the request and updates presence except during impersonation. Role checks are separate from workspace membership checks.
- `@Public()` and `@Optional()` are read from the route handler. `@Roles` supports class-level configuration. The MCP header can bypass session auth only on the MCP path, where `McpGuard` verifies it.
- `resolveAuthSecret` validates the signing secret at startup. Preserve the distinction between the auth signing secret and the application encryption keys. `BASE_URL` controls the better-auth base URL.
- Public email signup requires enabled signup and enabled mail. Public accounts begin pending approval and receive an email verification link. The approval hook requires a verified email before lifting the pending ban. Internal first-admin provisioning bypasses public signup gating.
- User deletion routes are disabled. Platform user administration uses the dedicated list/detail API and better-auth admin actions. Preserve workspace ownership and the platform role validation when changing auth plugins.

Use `task api:test` for auth config, guard, hook, and Redis storage specs. Exercise signup and verification only against the disposable local mail sink.
