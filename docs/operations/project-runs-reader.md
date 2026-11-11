# Project run reader foundation

The private reader pages attributed runs of an owned project before computing
status, scope size, and step counts. Pagination and total share one database
snapshot. Detached runs remain in project history;
mismatched workflow bindings do not become valid associations. It shares the
existing job-status expression with Jobs Registry.

Finding counts use exact observations plus older first/last run pointers.
Each owned finding counts once per run, including intermediate observations.
A first pointer match counts as new; other verified sightings count as recurring.
Counts include historical findings and do not infer missing sightings.

`GET /api/projects/:id/runs` requires `project.read` or the legacy `group.read`
alias. It accepts `page`, `limit`, optional `projectWorkflowId`, and optional
`jobRunType` (`manual` or `scheduled`). The response contains paged summaries,
with numeric counts and a nullable binding ID. Raw workflow configuration,
scope IDs, and step state are excluded. An out-of-range page retains the total.

Validate with `task api:test:e2e:one SPEC=test/project-runs-reader.e2e-spec.ts`
and the Task-generated OpenAPI and client. No schema, dependency, or UI changes.
Rollback is the previous application image; the reader does not write data.
