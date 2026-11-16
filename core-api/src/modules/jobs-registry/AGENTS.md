# Worker jobs and workflow runs

`jobs` records worker executions; `job_histories` records workflow runs.
`workflow-runner.service.ts` advances dependent steps after a terminal job.
The engine closes normally finished runs; cancellation can close a run under
the same run lock. A step with no input can complete without creating jobs.

- `getNextJobs` claims eligible jobs in batches under a write lock.
  Connector inputs and config resolve at dispatch. Repository credentials must
  stay out of saved inputs and logs.
- The private scan digest describes the resolved dispatch. A separate absolute
  PostgreSQL timestamp records when the initial claim started. `pickJobAt`
  distinguishes claim attempts and can be adjusted for ordering; it is not
  evidence of scan chronology. A reclaim clears the earlier scope and time.
- Worker results go to a private `job-results` object and the BullMQ queue. Each
  submission uses a unique key. The consumer checks the worker, job state, and
  reported category before ingesting. Cleanup works from the object key and age.
- Interrupted scans can send real findings with `error=false`. Only a clean
  connector Done can set `coverage_complete`; the gRPC handler accepts it as
  evidence only from the worker identified by the token. Old worker and HTTP
  reports still ingest findings. After ingesting a clean result, Core records
  coverage privately when the saved scope and claim still match. The evidence
  does not appear in REST. Closed workflows recompute a private count of
  comparable missed runs. A retry or retention can make the cache stale until
  the next recompute, so the count alone cannot close a finding. The lifecycle
  accounting path recomputes proof under locks and closes only at the saved
  threshold. Keep its exact database-clock fix event and private scan cutoff
  atomic. Protect the latest proof's history before taking finding locks, and
  defer closure when that parent is unavailable.
- Keep job terminal writes conditional: cancellation or a retry can change the
  state while a result is processing.

Run `task api:test` for API behavior and `task worker:test-race` when changing
worker result delivery or concurrency. Regenerate worker stubs with `task proto`
for changes to the gRPC schema.

Trusted fixed events publish exact committed lifecycle event IDs for the issue
automation lane. Keep proof identity and database fix time aligned; a transport
payload is not evidence and must never close remediation work on its own.
