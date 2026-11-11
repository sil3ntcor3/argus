# Argus integrations module

Integrations connect a workspace to notification, ticketing, cloud, and source-control services. `integrations.service.ts` validates connections and stores credentials encrypted with the workspace key. Keep masked secret placeholders distinguishable from replacements.

- `capabilities.ts` resolves connector capabilities. Schemas under `schemas/` describe accepted configuration and their connector registrations. `integration.validator.ts` handles validation, masking, and secret restoration.
- `IntegrationSyncService` and its BullMQ processor run cloud asset sync. The repository sync service and planner maintain Git organization repository assets. Keep queue payloads scoped and resolve credentials only for the operation that needs them.
- The controller uses `integration.read` and `integration.write` for workspace routes. Telegram pairing and webhook handling have separate entry points. Outbound notifications and ticketing also run through the integrations event sink.

Use service and processor specs and mock external connectors. Use disposable credentials and local fixtures for integration tests.
