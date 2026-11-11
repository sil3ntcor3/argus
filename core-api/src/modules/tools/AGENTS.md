# Argus tools module

This module owns the tool catalog, workspace installation, and connector configuration profiles. `ToolSyncService` loads built-ins and the generated connector manifest at boot. Use `task sync-connectors` to refresh the manifest.

- Catalog and installed-tool reads require `workspace.read`. Installing or removing a tool requires `workspace.write` and publishes the matching `tool.installed` or `tool.uninstalled` audit event. Keep the installed state workspace scoped.
- Profile DTOs return redacted values. `ToolConfigProfilesService` validates ownership and resolves the effective configuration. Preserve dispatch-time credential resolution and keep secret values out of job inputs and audit changes.
- `tool-categories.ts`, `tool-io.ts`, and `tool-target-types.ts` are shared by workflow validation and worker dispatch. Keep connector category, input, and target checks consistent at both boundaries.

Use the tool catalog, profile crypto, category/input, and audit wiring specs. Use local Docker for install and uninstall integration tests.
