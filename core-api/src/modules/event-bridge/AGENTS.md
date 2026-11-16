# Argus event bridge

The global `EventBridgeModule` publishes CloudEvents to the Redis stream `oasm:events`. Each lane has its own consumer group. The compatibility stream name is shared by publishers, consumers, and the live browser stream.

## Publish and consume

- `contracts/event-catalog.ts` declares event names and `routing/event-policy.ts` assigns persistence and severity. `routing/subscriptions.ts` selects domains per lane. Keep business-level filters in each sink's `accepts` method.
- The global interceptor reads `@PublishEvent` on HTTP handlers. It resolves the actor and workspace, redacts changes, metadata, and payloads, and captures `requestClientIp`. A missing workspace or failed extraction skips publication. A successful delete with no result ID can use `resourceIdFromRoute`.
- Direct publishers use `EventBridgeService`. Supply a workspace and outcome, and keep secrets out of the envelope. Direct `publish` does not redact payloads. The shared transport codec drops entries missing workspace or outcome.
- Consumers deliver at least once. They reclaim pending entries after 30 seconds and move repeated failures to a workspace dead-letter stream after five deliveries. Each sink needs replay-safe handling. A recreated group starts from the beginning of retained entries.
- `audit` alone holds an exclusive Redis consumer lock and persists configured events. `notifications` sends per-user pushes and must avoid subscribing to its own domain. `integrations` attempts best-effort delivery. `projects` links `asset.discovered` into project scope and also routes the three project-trigger events: assets added, run completed, and vulnerabilities detected. Runtime dispatch revalidates stored tenant/run/asset evidence; transport payloads alone are not authority. `projection` is registered for future use.
- In-process `EventEmitter2` signals such as `WORKFLOW_END` use separate routing. A local signal reaches the Redis stream only if its handler explicitly publishes an event.

Use `task api:test` for catalog-policy parity, boot wiring, publish redaction, retry, and sink checks.

Proposal/review audit events exclude proof and notes. `vulnerability.detected`
may omit `jobId` for a human-approved proposal; project dispatch must validate
the durable approval event rather than trusting that transport payload.

The issues lane consumes committed finding facts using private durable proof receipts. Redis markers are only a delivery optimization; do not truncate proof IDs or restore the legacy source queue.
