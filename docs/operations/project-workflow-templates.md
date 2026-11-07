# Project workflow templates

`GET /api/projects/workflow-templates` requires workspace membership and
`project.read` (or its legacy `group.read` alias). It returns the workspace's
immutable default workflows ordered by name, file path and ID. Each item contains
`filePath`, `name` and `jobs: [{ id, run, needs }]`. Legacy array jobs and scalar
dependencies are normalized. Empty catalogs return `[]`.

Configuration, profile IDs, triggers and credentials are excluded. The endpoint
does not change workflows or start runs. Existing workflow-template and project
routes retain their behavior. No schema or dependency changes are required.

Validate with `task api:test:one SPEC=src/modules/projects/project-workflow-templates.service.spec.ts`
and `task api:test:e2e:one SPEC=test/project-workflow-templates.e2e-spec.ts`, then
Task code generation and local Docker/browser checks. Roll back by deploying the
preceding application image; no stored data needs reverting.
