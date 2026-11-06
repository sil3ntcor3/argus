# Project provenance on new group runs

This runtime batch ports the run-attribution part of upstream open-asm #826 to
the existing Argus Groups workflow path. Manual and scheduled group runs save
the project's ID and the exact workflow-binding ID on their new job history.
Identity comes from the selected binding, so shared workflows and renamed
projects are attributed without name matching or inference.

The scheduler loads both nested workspace relations when resolving a persisted
binding. Run lookup requires the workflow and project to belong to the calling
workspace, including legacy rows whose binding crosses workspace boundaries.
Runs keep their selected asset scope. Standalone and target-triggered runs
without a binding retain NULL provenance; nothing backfills older runs again.

The IDs remain private to persistence and excluded from default ORM selections.
Existing `/api/asset-group` routes, responses, permissions, schedule keys, events
and Groups UI remain in place. No migration, dependency or API regeneration is
needed. Updating project/finding links and counts is a separate batch.

## Validation and rollback

Run `task api:test:one SPEC=src/modules/jobs-registry/workflow-runner.service.spec.ts`,
`task api:test:one SPEC=src/modules/asset-group/asset-group-workflow.service.spec.ts`
and `task api:test:e2e:one SPEC=test/project-run-provenance.e2e-spec.ts`.
The integration suite uses real PostgreSQL/Redis, two bindings sharing a
workflow, both manual and scheduler entry points, a rename, standalone target
runs, API privacy and tenant boundaries. HTTP probe steps have no live service
inputs, so no scanner jobs or outbound scans are created.

Deploy the API normally with the preceding provenance migration already
applied. A previous API image can still read these rows; it will leave new runs
unattributed. Roll back the application image without reverting or editing
applied migrations. Existing saved IDs stay intact.
