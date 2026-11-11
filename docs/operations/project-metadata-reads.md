# Canonical project metadata reads

`GET /api/projects` and `GET /api/projects/:id` include `description` (text or
null) and `autoAddAssets` (boolean). They retain existing project fields, counts,
workflow relations, pagination and permission requirements. `archivedAt` remains
private until the archive runtime is ready.

The canonical reader reuses the existing workspace-scoped project lookup and
loads metadata in one additional bound query per page, including the workspace
and returned IDs. Empty pages perform no metadata query. If a project disappears
between queries, detail returns 404 and lists omit the vanished row. Pagination
counts retain the existing count-query snapshot.

A separate view DTO exposes only the two selected metadata fields. It preserves
the entity's ordinary public properties without inheriting the private entity
JSON serializer. Legacy `/api/asset-group` responses continue excluding metadata.

Canonical POST/PATCH also accept description and automatic-membership preference;
see [metadata writes](project-metadata-writes.md). Scope matching, automatic
membership and archive activation follow separately. Reads do not run scanners
or change schedules. No database migration is required.
