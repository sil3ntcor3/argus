# Argus projects module

Projects organize workspace assets with manual selection, inclusion rules, and exclusions. They own workflow assignments and present run and finding provenance. Keep lookup and write checks in the selected workspace. Archived projects are historical views.

- The read side includes project metadata, assets, Overview, activity, workflow assignments, runs, and findings. Project routes use the `project.*` keys and existing compatibility aliases. Conditional run and finding fields also respect their domain permissions.
- `ProjectScopeDiscoveryService` links new assets from the event bridge. Scope rule writes and manual asset changes preserve provenance and serialize concurrent edits. An excluded asset stays excluded from automatic linking until the exclusion is removed.
- Project workflow creation accepts exactly one workspace template, selected job graph or same-workspace binding to copy, creating its disabled binding atomically. Copies preserve encrypted config and strip schedules/triggers; scope both the source project and workflow. Selected jobs reuse the pipeline editor's graph, tool/input, profile and secret validation. Workflow launches use enabled project assets and record the project and binding on the job history. Keep target-only runs separate from project provenance.
- Job and finding read models distinguish the original discovery, project membership, and findings attributed to a specific run. When a binding or project is removed, historical references follow their foreign-key behavior.

Use scope, workflow, and provenance specs. Validate ownership and lock ordering against local Docker Postgres.
