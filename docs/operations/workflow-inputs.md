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

The first batch added the vocabulary and pure helpers. The private `jobs.inputs`
column and dispatch support were ported previously.

## Catalog metadata

Tool category responses now describe ordered `inputs` and unordered `produces`.
Built-in tools, newly created provider tools and synchronized connectors store
these lists. Connector declarations take precedence; older manifests receive
category defaults. Unsupported kinds are reported and filtered, and capabilities
sharing a category merge their data kinds without duplicates.

The response fields are optional for compatibility with historical provider rows
that lack I/O metadata. Runtime resolution still supplies defaults for those
rows. No schema migration is required because categories already use JSONB.
The generated OpenAPI documents and console client include the additive fields.

The Argus connector manifest has not yet been enriched with upstream's
per-connector I/O declarations. That catalog update, scoped planning and the
Fast scan endpoint fix follow in separate batches. No dispatch or workflow-file
behavior changes in this metadata batch.

## Verification

Run `task api:test:one SPEC=src/modules/tools/tool-io.spec.ts` and
`task api:test:one SPEC=src/common/enums/enum.spec.ts` for defaults,
normalization, compatibility and ordered input validation. Each batch also runs
`task lint`, `task test`, `task console:test:run`, API/console builds and local
Docker/browser regression checks before publication.
