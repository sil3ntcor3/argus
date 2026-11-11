# Project asset candidates

`GET /api/projects/:id/assets/candidates` lists existing workspace assets that
are not members of this project. It requires `project.read`; the existing
`group.read` alias is accepted. Missing or foreign projects return 404, invalid
UUIDs return 400, and unauthenticated callers return 401.

The endpoint reuses the legacy tenant-scoped candidate query. Assets belonging
to other projects remain candidates. Disabled assets and existing metadata are
preserved. Reading candidates does not materialize scope rules, modify
membership, or publish project activity.

Query parameters are `search` (case-insensitive value matching), `page` (default
1), `limit` (default 10, maximum 100), `sortBy`, and `sortOrder` (`ASC` by
default or `DESC`). Supported sort columns are `createdAt`, `updatedAt`, and
`value`; other syntactically valid column names fall back to `createdAt`.
The response contains `data`, `total`, `page`, `limit`, `pageCount`, and
`hasNextPage`, using the existing asset representation.

The legacy `GET /api/asset-group/:assetGroupId/assets/not-in-group` endpoint is
unchanged. No schema, dependency, or UI change is required. Rollback deploys
the preceding application image; callers must use the legacy route again.

Validate with `task api:test:e2e:one
SPEC=test/project-asset-candidates.e2e-spec.ts` against disposable local
PostgreSQL/Redis, then run `task lint`, `task test`, `task console:test:run`, and
both application builds. After a fresh API boot, run `task gen-api` and commit
both OpenAPI documents and the generated client. Docker/browser validation
checks tenant isolation, permission aliases, pagination, search, disabled
candidates, metadata, and existing desktop/mobile group screens.
