# Agent cancellation and stream resume

This batch ports cancellation and resume fixes from upstream #798 while retaining Argus plan approval, command approval, prompts, and worker behavior.

## Behavior

- Stop aborts the main run on its owning API instance and cancels queued or running subagents of the owned conversation, even when the main run has already ended.
- Cancellation and dispatch lock the same conversation row. A dispatch carrying an aborted parent signal cannot enqueue after Stop wins that lock.
- Cancelled subagents retain their partial transcript, receive a completion timestamp, and stay terminal. They are neither claimed again nor delivered as completed results.
- Local subagents abort immediately. A subagent on another API instance notices cancellation on its existing 30-second heartbeat. Main-run cancellation still requires routing Stop to its owning API instance; distributed main-run cancellation is outside this batch.
- Resume replays only a Redis backlog that includes its begin marker. Trimmed history returns HTTP 204 and the console displays saved progress from the database. Pub/sub frames wait until backlog replay finishes and stream IDs suppress duplicates.
- Reload seeds history only through the last user message while a run is active, so replay rebuilds the assistant continuations of that turn.

The public subagent response status gains `cancelled`. The existing database column is varchar, so no migration is needed. Dependencies, workflows, worker contracts, and environment variables are unchanged.

## Deployment and rollback

1. Deploy the console before the API, or deploy both together: older consoles do not recognize the new status.
2. Deploy the API through the normal image rollout, preserving PostgreSQL and Redis. Let existing runs settle when replacing API instances; interrupted subagents retain their existing shutdown/requeue behavior.
3. In PLAN mode, confirm approval is requested before work starts. In AUTO mode, dispatch synthetic subagents, stop the conversation, and check that queued and running rows become Cancelled.
4. Reload a slow answer and confirm that its text appears once and finishes. On a trimmed replay, confirm saved progress stays visible and updates through polling.
5. To roll back the API, retain a console that understands `cancelled`: persisted cancelled rows remain valid data after the API rollback. Avoid rolling the console back to a version that cannot render those rows.

Regenerate the contract from a freshly booted API with the existing `.open-api/better-auth.json` fragment available to its spec merger, then run from the repository root:

```bash
task gen-api
task lint
task test
task console:test:run
task api:build
task console:build
```

Review both generated OpenAPI files and the generated console client together. Expected client changes are the two status enums and Stop's description; unrelated authentication type deletions indicate a missing authentication spec fragment during generation.

## Local validation

Validation uses a fresh disposable Docker project, synthetic users and a local OpenAI-compatible streaming model. It requires no paid model account or external scan target. Existing migrations are applied through `task migration:run` only to the disposable local database.

Regression tests cover the dispatch/cancel lock and abort signal, local and remote subagent aborts, shutdown with partial results, a late abort while final text resolves, Stop after the parent ends, ownership checks, trimmed replay, backlog/pubsub ordering, assistant continuation seeding, saved-progress fallback, and cancelled UI state.

## Subagent results between model steps

Completed or failed subagent results are handed to the main Agent before its next model step, using the existing result-delivery records. The first step keeps the results already present in its initial prompt. Ask mode keeps its existing behavior.

A receiving step must finish before its newly injected results count as consumed. If a provider fails before that step starts, a later iteration replays the evidence; if the turn stops or fails first, delivery is released for the next user turn. Earlier results remain available when continuation rebuilds the prompt.

This update uses existing APIs and database columns. Deploy or roll back the API image through the normal rollout; the console contract and Auto/Manual/Plan behavior are unchanged.
