# Argus admin module

Platform-admin controllers live under `/api/admin`. Controller-level `@Admin()` combines the global platform-role check with the saved IP allow-list for system configuration, tool creation, user reads, and workspace administration. Workspace permission checks are separate. `POST /api/admin/init` is public, skips the IP guard, and uses the first-admin lock and existing-admin check.

- `adminAccess.allowedIps` is live on every protected request. Empty/missing means unrestricted; explicit malformed stored policy fails closed. Changes reject self-lockout using the trusted-proxy resolver. Better Auth `/api/auth/admin` plugin actions are outside this guard.

- `system-configs` handles branding, signup settings, SMTP settings, and the test-mail route. The API redacts the mail password and returns its presence flag. Preserve encryption and key-rotation coverage when adding a stored secret. Test mail uses the configured transport.
- `users` exposes the platform user list and detail, omits the bot from the list, and owns the pending approval hook. Ban, unban, and impersonation use better-auth's admin plugin under `/api/auth/admin`.
- `PATCH /api/admin/workspaces/:id/storage-quota` accepts a nonnegative safe integer or null for the default. It locks the workspace before upserting only the quota override, preserves byte balances, and records `storage.quota.updated` with the saved quota and platform-admin attribution.
- `workspaces` exposes platform-wide workspace reads, updates, and archive controls. Workspace admin updates still record workspace audit events.

Use `task api:test` for bootstrap, system settings, mail, and account approval checks. Run verification and test mail against a local sink.
