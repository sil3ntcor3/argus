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

Scoped planning and the Fast scan endpoint fix follow separately. Catalog
metadata alone does not change dispatch or workflow-file behavior.

## Connector declarations

The manifest generator fills missing I/O declarations from the source-controlled
`core-api/resources/connectors/io-defaults.json`, derived from the pinned upstream
catalog. Existing canonical declarations win, including empty produced lists.
Images, versions, target types and other canonical metadata are preserved.
Unknown custom connectors are left untouched and use category defaults at sync.

Run `task sync-connectors` to fetch the canonical Argus catalog and regenerate
the manifest with these compatibility defaults. `MANIFEST_PATH` still supports a
local catalog input. Update the defaults' source commit when auditing newer
upstream declarations; do not copy upstream image or version fields into them.
The generator validates defaults before atomically replacing the output. Run
`task api:test:one SPEC=src/modules/tools/connector-manifest.spec.ts` for its
offline CLI, canonical-precedence and atomic-failure regression checks.

## Verification

The pure step planner now chooses the first available input kind per asset,
creating one planned job per service or URL. Web targets retain their observed
scheme and non-default port; IPv6 authorities are bracketed. URL inputs must be
valid HTTP(S) links on the scoped asset's host, so captured external links cannot
expand a scan's scope. If no eligible URL remains, later input kinds still apply.
Repository inputs remain deferred until claim time for live credential lookup.
The planner is not yet wired into job creation; scope loading follows separately.
Run `task api:test:one SPEC=src/modules/jobs-registry/step-inputs.spec.ts` for
ordered fallbacks, endpoint fan-out, scope filtering and repository behavior.

Run `task api:test:one SPEC=src/modules/tools/tool-io.spec.ts` and
`task api:test:one SPEC=src/common/enums/enum.spec.ts` for defaults,
normalization, compatibility and ordered input validation. Each batch also runs
`task lint`, `task test`, `task console:test:run`, API/console builds and local
Docker/browser regression checks before publication.
