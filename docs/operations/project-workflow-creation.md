# Project workflow creation

`POST /api/projects/:id/workflows` requires effective `project.write` in the
selected workspace and a non-archived project. The existing `group.write`
compatibility alias also applies.

Supply exactly one source: `template`, a default workspace template path, or
`jobs`, a map of 1–50 stable job IDs. Selected jobs use the pipeline editor's
DAG, tool-reference, category/input and workspace-profile validation. New inline
connector secrets are encrypted with the workspace key. Invalid combinations
or graphs return 400; missing references return 404.

The optional name defaults to the template name or `Project workflow` for jobs.
Creation atomically stores a project-owned workflow and a disabled binding,
without copying triggers or starting a run. The unchanged 201 receipt contains
`id`, `workflowId`, `name`, and `schedule: "disabled"`.

In Projects → Workflows → Create workflow, choose a template or Selected tools.
The tools source supports staged pipelines and inline installation. Catalog
refreshes retain the draft name and selections. An ambiguous server response
blocks retries until the dialog is closed and the assignments are checked.

Validate with `task api:test:one SPEC=src/modules/projects/project-workflow-create.service.spec.ts`
and `task api:test:e2e:one SPEC=test/project-workflow-create.e2e-spec.ts` against
local Docker Postgres/Redis. Regenerate the live spec and client with `task gen-api`.
