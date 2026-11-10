# Argus admin module

Platform-admin controllers live under `/api/admin`. Controller-level `@Roles(Role.ADMIN)` protects system configuration, tool creation, user reads, and workspace administration. Workspace permission checks are separate. `POST /api/admin/init` is public and uses the first-admin lock and existing-admin check.

- `system-configs` handles branding, signup settings, SMTP settings, and the test-mail route. The API redacts the mail password and returns its presence flag. Preserve encryption and key-rotation coverage when adding a stored secret. Test mail uses the configured transport.
- `users` exposes the platform user list and detail, omits the bot from the list, and owns the pending approval hook. Ban, unban, and impersonation use better-auth's admin plugin under `/api/auth/admin`.
- `workspaces` exposes platform-wide workspace reads, updates, and archive controls. Workspace admin updates still record workspace audit events.

Use `task api:test` for bootstrap, system settings, mail, and account approval checks. Run verification and test mail against a local sink.
