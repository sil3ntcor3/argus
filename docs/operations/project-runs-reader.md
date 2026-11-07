# Project run reader foundation

The private reader pages attributed runs of an owned project before computing
status, scope size, and step counts. Pagination and total share one database
snapshot. Detached runs remain in project history;
mismatched workflow bindings do not become valid associations. It shares the
existing job-status expression with Jobs Registry.

No HTTP, schema, dependency, or UI changes. Validate with
`task api:test:e2e:one SPEC=test/project-runs-reader.e2e-spec.ts`. Rollback is
the previous application image; the reader does not write data.
