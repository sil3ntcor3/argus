# Canonical project metadata writes

`POST /api/projects` and `PATCH /api/projects/:id` accept nullable `description`
(maximum 2,000 characters) and strict boolean `autoAddAssets`. Omission defaults
to null/true on creation and preserves values on update. Descriptions are trimmed;
null or blank clears them. Null/string/number booleans return 400. Canonical names
are limited to 120 characters and colors to six-digit hex, matching upstream.

Mutations return the canonical project view with metadata and counts. Metadata is
saved in the initial write, so creation rollback also removes it. The response
uses the scoped read path; concurrent deletion can return 404 after a saved write.

Legacy `/api/asset-group` inputs and privacy remain unchanged; updates preserve
metadata. Archive state stays private and cannot be set. Automatic membership,
scope matching and archive behavior follow separately. No schema/dependency changes.
