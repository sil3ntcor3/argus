# Project discovery event consumer

The `projects` consumer group handles typed `asset.discovered` batches on the
existing Redis event stream. It validates, canonicalizes and deduplicates asset
UUIDs, then calls the transactional project scope discovery service in the
event's workspace. Empty or malformed legacy payloads are ignored.

After attachment commits, each project that gained members emits the runtime
fact `project.assets.added` and a system-authored `project.updated` audit event
with `change: assets.discovered` and the number added. Valid optional run IDs
travel with the runtime fact. Replaying an already attached batch emits no new
membership report. Attachment errors propagate to the existing retry/DLQ path.

Publishing reports uses the existing best-effort bridge; it is not a durable
outbox. A Redis outage after the membership commit can lose the report. The
consumer does not subscribe to its project output, preventing a feedback loop.
[Scan/integration refresh ingest](asset-discovery-events.md) now produces these
batches. Initial target assets and project event-triggered runs follow separately.
Existing user action and legacy group events remain.

The small `ProjectScopeModule` shares the discovery provider without importing
the project CRUD/workflow graph into the global bridge. No schema changes.
