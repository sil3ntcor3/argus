# Argus workers module

This module owns worker identity, liveness, inventory, the worker gRPC channels, and worker selection for agent commands. Job claim and results live in `jobs-registry`. The Go worker runs connector containers.

## Entry points

- `workers.controller.ts` serves HTTP inventory and join keys, plus gRPC join, alive, archive reads, tool inventory, telemetry, and remote execution.
- `workers.service.ts` manages registration, liveness, stale-worker cleanup, inventory, job release, and internal network links.
- `worker-stream.controller.ts` and `worker-stream-registry.service.ts` manage the bidirectional `Connect` stream for registration, heartbeats, cancellations, and job hints. Keep job claims and results on their own RPCs.
- `remote-execute-subscribe.service.ts` manages remote execution streams, result routing, and conversation pins. `alive-stream-manager.service.ts` tracks `Alive` streams.
- `worker-join-key.service.ts` manages short-lived Redis join keys. `worker-telemetry.service.ts` normalizes reports and `redis-worker-telemetry.store.ts` stores them.

## Access and identity

- `POST /api/workers/alive` and `POST /api/workers/join` accept the credentials in their request bodies. Issuing, rotating, and revoking join keys requires `workspace.apikey`.
- `GET /api/workers` and `GET /api/workers/:id` require `worker.read`. Non-admins see only workers in the selected workspace and receive 403 if they explicitly request the cloud list. Preserve list and detail DTOs that omit worker tokens.
- A live workspace join key is consumed atomically with Redis `GETDEL` and expires after five minutes. It resumes the supplied token only when the token already belongs to a worker in that workspace. Without a live workspace key, a known token can resume its worker. `ARGUS_CLOUD_APIKEY` authenticates global workers.
- gRPC `Join`, `Alive`, and `GetManifest` do not use `GrpcWorkerTokenGuard`. The RPCs that read archives, report telemetry, connect an internal network, or handle remote execution do. `Connect` checks the `worker-token` metadata itself.
- Tool archive reads accept regular files inside an approved platform directory and reject symlinks. Keep the checks in `openToolArchive` and `toolArchivePlatform` when changing the archive format.

## Liveness and routing

- `Alive` uses process-local stream state. The durable liveness signal is `lastSeenAt`. Dropping the stream requeues in-progress jobs and keeps the worker row for rejoin. The 60-second sweep also requeues in-progress jobs whose worker row is missing, and failed jobs with remaining retries and an asset. Jobs with no asset cannot be claimed.
- Every API replica runs the stale-worker sweep. A stale row with no local stream can be removed. Only the replica that deletes it announces `worker.timed_out`. Worker events are scoped to workers with a workspace.
- Workspace workers serve their own workspace. A global worker is a built-in cloud worker and must subscribe with agent sandbox support to serve agents. Provider workers never serve agents.
- Agent commands try a usable Redis conversation pin, then the stored Postgres pin, then an available workspace or eligible global worker. The caller writes a new pin only after a successful push. A recorded result assignment rejects other workers. Sessions with no recorded push keep the legacy acceptance behavior.
- Stream holders are local to an API process. Cancellations and job hints fan out through Redis on `worker:stream:cancel` and `worker:stream:jobs`. Each replica forwards to the streams it holds locally. Telemetry uses the existing `oasm:worker:telemetry:v1:` key prefix with a 90-second TTL.

## Verification

Run `task api:test` from the repository root. Focused specs cover worker join and inventory, the stream controllers and registries, join keys, telemetry, and remote execution. Run `task proto` after changing `src/proto/workers.proto`. Never hand-edit the generated worker stubs.
