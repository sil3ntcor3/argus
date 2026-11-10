# Argus search module

`SearchService` serves asset and target results for console search. `GET /api/search` requires both `asset.read` and `target.read`. The console loads finding results through the separate permission-checked vulnerability API.

- Keep every result query workspace scoped. Search history belongs to a user, so history listing and deletion must scope to the authenticated user independently of result permissions.
- Use the search service specs to check permissions, filters, and history ownership.
