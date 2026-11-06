# Workflow input port

This port is implemented in separate batches from upstream #827 and #823.

## Data-kind foundation

`DataKind` describes what a step consumes or produces: `target`, `host`,
`service`, `web`, `url`, `repository` and `vulnerability`.
The helpers in `tool-io.ts` provide backward-compatible category defaults,
normalize declared lists while preserving preference order, and reject a step
that requests inputs its tool does not accept. Findings are output-only;
targets are input-only.

An omitted input list uses category defaults. An explicit capability input list
can allow a step to narrow or reorder those inputs. Repository-only vulnerability
scanners default to repository inputs; mixed or host target types retain host
defaults. An empty produced list means a tool produces no additional data.

This first batch adds the vocabulary and pure helpers only. It does not change
catalog responses, job planning, worker dispatch, workflow files or the schema.
Catalog metadata, scoped planning and the Fast scan endpoint fix follow in
separate batches. The private `jobs.inputs` column and dispatch support were
ported previously.

## Verification

Run `task api:test:one SPEC=src/modules/tools/tool-io.spec.ts` and
`task api:test:one SPEC=src/common/enums/enum.spec.ts` for defaults,
normalization, compatibility and ordered input validation. Each batch also runs
`task lint`, `task test`, `task console:test:run`, API/console builds and local
Docker/browser regression checks before publication.
