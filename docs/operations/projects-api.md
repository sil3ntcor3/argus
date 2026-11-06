# Projects CRUD API

The canonical project CRUD endpoints use the same records and services as the
legacy `/api/asset-group` endpoints. Creating or updating through either API is
immediately visible through the other. Existing Groups console routes remain in
place during the incremental Projects port.

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| GET | `/api/projects` | `project.read` | 200, paginated project list |
| POST | `/api/projects` | `project.write` | 201, created project |
| GET | `/api/projects/:id` | `project.read` | 200, project |
| PATCH | `/api/projects/:id` | `project.write` | 200, updated project |
| DELETE | `/api/projects/:id` | `project.write` | 200, success message |

Supply the selected workspace through `X-Workspace-Id`. The exact legacy
`group.read/write` aliases remain valid, with the existing write-implies-read
access rule. Authentication, workspace membership and resource scoping apply to
every operation. UUID parameters and existing request/query DTOs are validated.
The initial list, creation and update shapes match their legacy equivalents.

Both paths retain the current audit/event and protected-workflow deletion
behavior. There is no schema change or data copy. Rolling back this controller
leaves the records usable through the legacy API. Scope, archive, provenance
views, nested workflow operations and triggers follow in separate batches.
