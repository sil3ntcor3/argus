# Project workflow creation

`POST /api/projects/:id/workflows` requires effective `project.write` in the
selected workspace and a non-archived project. The existing `group.write`
compatibility alias also applies.

Supply exactly one source: `template`, a default workspace template path;
`jobs`, a map of 1–50 stable job IDs; or `copyFromProjectWorkflowId`, a binding
ID in the selected workspace. Selected jobs use the pipeline editor's
DAG, tool-reference, category/input and workspace-profile validation. New inline
connector secrets are encrypted with the workspace key. Invalid combinations
or graphs return 400; missing references return 404.

The optional name defaults to the template name, `Project workflow` for jobs,
or the source workflow name plus ` (copy)`.
Creation atomically stores a project-owned workflow and a disabled binding,
without copying triggers or starting a run. The unchanged 201 receipt contains
`id`, `workflowId`, `name`, and `schedule: "disabled"`.

A copy source may belong to another project, including an archived source.
Both its project and workflow must belong to the selected workspace. Copying
preserves encrypted configuration and profile references under the same key,
and omits instructions, triggers, schedules and run history. Inaccessible
sources return 404 and invalid stored graphs return 400. The source is unchanged.

In Projects → Workflows → Create workflow, choose a template or Selected tools.
The tools source supports staged pipelines and inline installation. Catalog
refreshes retain the draft name and selections. An ambiguous server response
blocks retries until the dialog is closed and the assignments are checked.

Validate with `task api:test:one SPEC=src/modules/projects/project-workflow-create.service.spec.ts`
and `task api:test:e2e:one SPEC=test/project-workflow-create.e2e-spec.ts` against
local Docker Postgres/Redis. Regenerate the live spec and client with `task gen-api`.
