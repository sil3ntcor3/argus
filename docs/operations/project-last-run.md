# Project run attribution

Canonical `/api/projects` reads use persisted project provenance for `lastRunAt`
and exact project/workflow bindings for nested run summaries. A newer standalone
or another project's run of a shared workflow cannot replace those summaries.
Workflow tenant checks exclude inconsistent foreign-workflow records.

`lastRunAt` sorting happens before pagination, with unknown runs last and UUID
tie-breaking. Project timestamps survive binding removal; replacement bindings
do not inherit old binding summaries. Existing zero-job summary handling stays
in place. Legacy `/api/asset-group` behavior and JSON remain unchanged.

No schema, dependency, or API-shape changes. Validate with `task api:test:e2e:one
SPEC=test/project-last-run.e2e-spec.ts`, full Task checks and local Docker/browser
flows. Rollback deploys the preceding application image; stored runs are unchanged.
