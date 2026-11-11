# Tool installation audit trail

Argus records workspace tool installs and uninstalls through the existing event
bridge. This ports the audit portion of upstream open-asm #831.

## Operator check

1. Open a workspace's Tools page and install a tool.
2. Open the workspace Audit log and filter by **Installed tool**. The successful
   row identifies the actor, workspace, tool ID, and tool name (`changes.tool.after`).
3. Uninstall the tool. Filter by **Uninstalled tool** to see its name in
   `changes.tool.before`, even though the installation association is gone.
4. Use the outcome filter to distinguish successful operations from rejected
   duplicate, missing-tool, or not-installed attempts. Requests rejected by
   authentication/workspace guards never reach the audited handler.

`tool.installed` has normal severity; `tool.uninstalled` has important severity.
Both persist to the audit trail. Neither is routed to notifications or external
integrations. Audit delivery uses the existing asynchronous Redis consumer, so
rows may appear shortly after the HTTP response.

## API compatibility and validation

- `POST /api/tools/install` still returns the installation entry. Its `tool`
  relation now contains `{ id, name }`; its workspace relation remains `{ id }`.
- `POST /api/tools/uninstall` retains its success message and adds `toolId` and
  `toolName`. Installation removal and configuration-profile cleanup remain one
  transaction. Error statuses and workspace permission checks are unchanged.
- Both Swagger responses and the generated client describe these fields. Existing
  clients that consume only the previous fields remain compatible.
- Run `task api:test:one SPEC=src/modules/tools/tools.audit-wiring.spec.ts`,
  `task api:test:one SPEC=src/modules/tools/tools.service.spec.ts`, and
  `task api:test:e2e:one SPEC=test/tool-install.e2e-spec.ts` against local test
  infrastructure. The integration test verifies persisted outcomes and tenancy.

No migration or dependency change is required. Rolling back the application
removes future tool audit emission and the additive response fields; existing
append-only audit rows remain stored under their original action names.
