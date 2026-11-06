# Atomic project scope replacement

`PUT /api/projects/:id/scope-rules` accepts `{rules, autoAddAssets?}` and returns
numeric `{added, removed}` counts with HTTP 200. It requires `project.write` or
the existing `group.write` grant. Rules are limited to 100 rows with string values
up to 255 characters; the optional preference must be a boolean, including false.
Null preferences and invalid or foreign references are rejected.

Replacement locks the owned project row and validates references through the
same transaction manager. It replaces the rules, optionally updates the preference
and reconciles rule membership before committing. Normalization deduplicates
canonical rules. Stored creation/ID order determines first-match provenance;
input order is not promised. Omitting the preference preserves its saved value.
Empty rules remove rule-source members while retaining manual members.

An error rolls back rules, preference, membership and provenance together.
Concurrent replacements use the shared project lock, also used by legacy manual
membership mutations. Canonical writes emit
[project activity](project-activity.md); the
[discovery consumer](project-discovery-events.md) attaches new discovery batches.
Reporting assets added by an explicit scope edit follows separately.

Run `task api:test:e2e:one SPEC=test/project-scope-write.e2e-spec.ts` against the
disposable local Docker database. Public permission, validation and response tests
are in `test/project-scope-read-api.e2e-spec.ts`; unit tests cover the service's
transaction boundary and failures. Regenerate the tracked API spec and client with
`task gen-api` after booting the changed API. Code rollback disables this route;
it does not undo committed rule or membership changes.
