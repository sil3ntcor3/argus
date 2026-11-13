# Resource comment storage (Open ASM v0.12.1)

This foundation follows release `961d77142671e90190bd97132638441e593bec47`.
It generalizes the existing comment store without enabling finding-comment
routes, writers, permissions, events or UI. The internal `IssueComment` class
name stays in place for legacy callers until the runtime port follows.

`task migration:generate name=GeneralizeResourceComments` generated the new
migration. Its reviewed correction renames `issue_comments` to `comments`
in place, preserves the primary/creator/issue/reply constraints and their
behavior, and removes unrelated TypeORM schema churn. It retains every legacy
ID, body, reply, timestamp, soft-deletion marker and edit/delete flag.

The approved additions are nullable `vulnerabilityId` with cascade cleanup,
an index on that column plus creation time, nullable `issueId`, and a CHECK
requiring exactly one subject. The existing issue/creation-time index is
renamed. The new subject field stays hidden from ordinary entity/API reads.

Legacy issue operations still scope through their issue. Replies must refer
to the same issue, including a soft-deleted parent. Reads redact stale
cross-subject reply pointers and bodies without rewriting stored records.
A finding-only comment cannot trigger the retired issue-assistant lookup:
TypeORM must never receive an absent issue ID and treat it as an unfiltered
lookup. Creator/reply foreign-key behavior otherwise stays unchanged.

Coordinate the API rollout: pause legacy comment writes and stop old API
instances before applying the rename, then start the updated API. Old images
query the retired table name. This is not a mixed-version rolling migration.
Keep a database backup until migration and application checks pass.

Rollback takes an exclusive table lock before checking for finding comments.
If any exist, it refuses before removing the new subject column. Preserve or
export those comments and handle them deliberately before attempting downgrade;
do not delete them automatically to make rollback succeed. With issue-only
rows, rollback restores the old table, index and constraint names and issue
nullability without deleting comments.

Validate upgrade, guarded refusal, rollback and re-upgrade on local Docker
Postgres with seeded replies, null actors, soft deletion, flags and exact
microsecond timestamps. Compare all unrelated schema metadata. Check subject
constraints, FK/cascade behavior, legacy operations and reply privacy against
real Postgres. Verify the live OpenAPI document stays unchanged and run the
desktop/mobile lifecycle, Templates and project AI/Files regressions.
