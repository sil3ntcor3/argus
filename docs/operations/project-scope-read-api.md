# Project scope-rule reads

`GET /api/projects/:id/scope-rules` requires workspace membership and
`project.read` (including the existing `group.read` alias). Send the project UUID
and `X-Workspace-Id` header. Anonymous requests receive 401, insufficient workspace
access receives 403, and missing or foreign projects receive 404.

The response contains `rules`, `autoAddAssets`, `ruleAssets`, and `manualAssets`.
Each rule exposes only `id`, `mode`, `type`, `value`, `label`, and `matched`.
Rules retain their saved creation/ID order. Labels resolve only owned targets and
assets; unavailable labels fall back to the stored rule value.

`matched` counts each include rule's matches, or the include matches removed by an
exclusion. Membership counts describe currently stored, owned project members by
their provenance; they can differ from preview matches before synchronization.
Empty projects return an empty rule array, zero counts, and their saved automatic
membership preference. The endpoint does not write or synchronize membership.

Validate against the disposable local Docker database:

```bash
task api:test:e2e:one SPEC=test/project-scope-read-api.e2e-spec.ts
```

Regenerate the tracked OpenAPI files and console client with
`task gen-api` after booting the updated API. Reverting this batch removes the
read endpoint and its generated client without changing persisted rules or members.
