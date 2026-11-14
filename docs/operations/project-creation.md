# Project creation

Projects → Create project supports manual assets, include/exclude scope rules,
automatic membership, an optional initial workflow, and disabled or enabled
schedule/event definitions. Preview counts rule matches after exclusions;
manually selected assets are added separately and retain their manual membership.

Choose a workspace default template or build a selected-tool pipeline. The
pipeline retains Argus's stages, categories, inputs, profiles and inline connector
configuration. A template copies its jobs without inheriting its authored target
or schedule. The new page defaults to manual launch and disabled triggers.
Only users with effective `workflow.write` see activation and Run after creating.

## API and consistency

`POST /api/projects` retains `project.write` and the existing workspace selection.
Optional `scopeRules`, `template`, `jobs`, `workflowName`, `on`, and `runNow` enable
the enriched path. Supply at most one initial pipeline source: template, jobs,
or existing tools/toolIds. Explicit `on` overrides legacy `schedule`. A workflow
name, triggers, enabled schedule or `runNow: true` requires a pipeline. Enabled
triggers and run-now also require `workflow.write`, checked before setup writes.

Scope rules use the existing 100-rule bounds and normalization. Selected graphs
use the existing 1–50-job validation. Tool/profile/template and asset references
are checked in the selected workspace. New connector secrets are encrypted;
stored template ciphertext remains readable with the workspace key. Project,
scope, workflow, binding and trigger writes commit together or roll back together.
Run launch and scheduler reconciliation happen after commit.

The HTTP 201 receipt preserves the project fields and may add `creation`:

```json
{
  "initialRun": {"status": "started", "jobHistoryId": "<run UUID>"},
  "triggerSync": "complete"
}
```

`initialRun` is omitted unless run-now was requested. Its status can also be
`empty_scope` (no enabled assets) or `failed` (saved project needs a manual
launch). A failed launch exposes no raw error or connector configuration.
`triggerSync` is omitted when no synchronization was requested, or is `pending`
when the existing periodic reconciler must retry saved definitions. These
outcomes retain the project and return 201. Navigate to the saved project to
inspect its scope, workflows and triggers rather than submitting creation again.

Clients supplying none of the new fields retain the legacy response and schedule
defaults. The new UI disables automatic mutation retries and duplicate submits.
An ambiguous network/server response freezes the draft and offers Check projects
so the user can inspect whether creation committed before trying again.

## Validation

Run from the repository root:

```bash
task api:test:one SPEC=src/modules/projects/project-creation.service.spec.ts
task api:test:e2e:one SPEC=test/project-creation-flow.e2e-spec.ts
task test
task console:test:run
task lint
task api:build
task console:build
task gen-api
```

Use a local Docker database and Redis for HTTP integration tests. Cover legacy
schedules, transactional rollback, foreign references, secret encryption, launch
permissions, initial runs, empty scope, postcommit recovery and concurrent names.
Check desktop/mobile creation, rule preview, staged pipelines and permission
revocation against the local Docker UI. No schema or dependency change is needed.
