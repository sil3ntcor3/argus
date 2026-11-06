# Private project metadata foundation

`AddProjectMetadata1793970489894` adds three columns to `projects`:

| Column | Storage | Initial value |
| --- | --- | --- |
| `description` | nullable text | null |
| `autoAddAssets` | non-null boolean | true |
| `archivedAt` | nullable timestamp with time zone | null |

The defaults match upstream and apply to existing rows as well as new projects.
This foundation keeps the fields private to persistence. It does not enable
scope matching, automatic membership, archiving, schedule changes or public
metadata inputs. Their runtime behavior and APIs follow separately.

Default entity queries omit these columns. JSON serialization also strips them:
TypeORM save results can contain nullable columns and default values even when
`select: false` is set. Both `/api/projects` and `/api/asset-group` retain their
current create, list, detail and update response shapes. Unknown metadata inputs
remain excluded by the existing DTOs.

Back up the database before applying migrations through the normal migration
service. For a verified local database, use `task migration:run`. To roll back,
stop versions that depend on this metadata, confirm this is the latest applied
migration, and use `task migration:revert`. Rollback drops the three new columns
and their values; preserve a backup if metadata has been written. Existing
project names, colors, workspace links, asset membership, workflows and run
provenance remain intact.

`core-api/test/project-metadata.e2e-spec.ts` covers defaults, explicit persistence,
ordinary-read privacy, save-result serialization and both HTTP API surfaces.
Migration validation should additionally cover upgrade, rollback and reapply
without changing existing project rows or related records.
