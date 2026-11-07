# Canonical project members

`GET /api/projects/:id/assets` requires `project.read` or its `group.read`
alias. It returns paginated members with target details, manual/rule source,
nullable rule reason, membership time, project-linked open severity counts,
and the latest project-scoped scan. Private IDs and stored run inputs stay hidden.

Use `source=manual|rule`, case-insensitive `search`, positive integer `page`,
and integer `limit` from 1 to 100 (default 10). `sortBy=value` sorts by asset
value; `addedAt`, `createdAt`, and unknown safe keys use membership time.
`sortOrder` defaults to `ASC`. Reads never synchronize or modify membership.
Missing/foreign projects return 404, malformed input 400, missing grants 403,
and anonymous requests 401. The legacy member route and JSON are unchanged.

Validate with `task api:test:e2e:one SPEC=test/project-assets-read-api.e2e-spec.ts`,
full Task checks, local Docker and desktop/mobile browsers. After API boot,
run `task gen-api`. Rollback deploys the preceding image; no schema changes.
