# Resolved job input foundation

This batch ports the persistence and dispatch foundation from upstream #827.
It prepares Argus for precise connector targets such as
`https://app.example.com:8443` without changing the worker protocol.

## Behavior

- `jobs.inputs` is nullable JSONB, with no default or historical backfill.
- The column is private: normal entity queries do not select it, REST job
  responses do not expose it, and it has no OpenAPI property.
- Worker claims explicitly load it. Both `Next` and `NextBatch` send a saved
  non-repository input snapshot through the existing connector input map.
- The legacy HTTP worker-claim response strips the private snapshot and retains
  its existing response contract.
- Jobs without a snapshot keep the existing asset-derived input behavior.
- Repository jobs ignore stored inputs. Clone metadata and current credentials
  are resolved at dispatch, including the existing unauthenticated fallback.
  Repository tokens must never be persisted in this column.
- Built-in command execution is unchanged.

No production planner writes snapshots in this batch. Typed input planning,
tool input/output declarations, workflow input controls and endpoint fan-out
follow separately. This batch alone does not complete upstream #823.

## Local migration and verification

1. Confirm the database environment points at a disposable local PostgreSQL
   instance. Never use a shared, staging or production database for validation.
2. Apply migrations from the repository root with `task migration:run`.
3. Run `task api:test:one SPEC=src/modules/jobs-registry/jobs-registry.controller.spec.ts`
   and `task api:test:one SPEC=src/modules/jobs-registry/jobs-registry.service.spec.ts`.
4. With local PostgreSQL, Redis and storage available, run
   `task api:test:e2e:one SPEC=test/job-inputs.e2e-spec.ts`.
   It checks real persistence, single/batched claims, legacy fallback, normal
   entity reads, REST privacy and workspace authorization.
5. Run `task lint`, `task test`, `task console:test:run`, `task api:build` and
   `task console:build`. Validate the built API and console in local Docker,
   including desktop/mobile job and run screens.

The migration was generated using
`task migration:generate name=AddJobInputs`. Unrelated constraint/index changes
were removed from the newly generated file before applying it.

## Rollback and compatibility

The old application can use the upgraded schema because the new column is
nullable and it ignores input snapshots. Apply the migration before deploying
the new API: worker claims explicitly select the column and require it to exist.

For a local rollback check, stop the API, ensure this is the latest migration,
and run `task migration:revert`, then `task migration:run` to reapply it.
Rollback drops only `jobs.inputs`; existing job rows remain, but saved snapshots
are lost. Once a later planner starts writing snapshots, drain affected jobs or
retain a database backup before reverting either the schema or dispatch code.
