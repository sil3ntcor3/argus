# Worker job hints

Core-api sends an additive `JobsAvailable` frame (field 4 of `CoreToWorker`) on the existing authenticated Connect stream. The empty message asks the worker to call NextBatch sooner; NextBatch remains responsible for eligibility, tenant isolation, and the atomic claim. It does not carry a job or grant permission to execute one.

## Delivery

1. Job creation publishes after the repository save succeeds. A manual rerun publishes after its transaction commits.
2. The API publishes the workspace ID to Redis channel `worker:stream:jobs`. Every API instance receives it, including an instance holding a worker stream opened elsewhere.
3. Each instance nudges its connected cloud workers and workers belonging to that workspace. Workers from other workspaces receive no hint. Tool and network eligibility remain in NextBatch.
4. The worker buffers at most one pending hint. Receiving a burst never blocks heartbeats/cancellation or repeatedly postpones an already scheduled claim.

Publication is best-effort and does not fail a durable job save. Redis Pub/Sub is not a durable queue: a lost hint, a disconnected stream, and requeues without a hint rely on fallback polling. Separate channel checks keep job hints and cancellation events isolated. Reconnecting a worker replaces the old stream without allowing stale teardown to unregister the replacement.

## Polling behavior

An idle worker starts polling after one second. Consecutive empty or failed claims back off through 2, 4, 8, 16, and 30 seconds. Once idle backoff has grown, a hint schedules a claim after 100 ms. Once jobs are flowing, freed capacity refills on the existing 100 ms cadence. Full concurrency capacity retries after 200 ms without treating the busy worker as an empty queue.

No new environment variable or database migration is required. Keep the worker-state volume to retain the join token. Rejoining the same identity also requires the API to retain its worker record; existing offline cleanup can expire that record during a long stop. Existing OASM wire/package identifiers remain compatibility surfaces.

## Deployment and compatibility

Deploy the API first, then workers. Older workers ignore the new oneof field and retain their existing polling. A new worker connected to an older API still claims through NextBatch, but receives no hints and can wait up to 30 seconds for a newly queued job.

The change does not alter stored data. API or worker images can be rolled back independently with data/state volumes retained; old worker polling can increase API traffic. This does not change the separate encryption rollout/rollback requirements in [the security port guide](../operations/security-port-rollout.md).

## Verification

Run from the repository root:

```bash
task proto
task api:test:one SPEC=src/modules/workers/worker-stream-registry.service.spec.ts
task api:test:one SPEC=src/modules/workers/worker-stream.controller.spec.ts
task api:test:one SPEC=src/modules/jobs-registry/jobs-registry.service.spec.ts
task worker:test-race
task worker:lint
task worker:check
task lint
task test
```

For a live rehearsal, use disposable local data and at least two API instances sharing Redis and Postgres. Open worker streams on one instance and create/rerun jobs through the other. Verify workspace/cloud routing, idle wake-up, coalescing, reconnects, and polling after intentionally dropped hints. Use only owned local scan fixtures; inspect the existing worker/job UI in a browser as well as transport timing.
