# Argus artifacts module

This module owns workspace files, quota accounting, and cleanup. The console calls the feature Files. All object keys live in the private `artifacts` bucket.

## Entry points and permissions

| Route | Selected workspace access |
| --- | --- |
| `GET /api/artifacts` | `artifact.read` for the caller's ready files. `scope=all` also requires `artifact.manage`. |
| `GET /api/artifacts/usage` | `artifact.read`. Returns quota, used bytes, reserved bytes, and the per-file limit. |
| `GET /api/artifacts/:id` | `artifact.read` for the owner, or `artifact.manage` in addition for other ready files. |
| `GET /api/artifacts/:id/download` | `artifact.read` and ownership of the ready file. |
| `DELETE /api/artifacts/:id` | `artifact.read` plus either `artifact.write` and ownership, or `artifact.manage`. |
| `GET /api/artifact-folders` | `artifact.read` for the caller's root folders or direct children of an owned `parentFolderId`. |
| `GET /api/artifact-folders/:id` | `artifact.read` and ownership of the folder and its breadcrumb. |

- `ArtifactReadService` scopes queries to the selected workspace and ready files. Foreign, pending, deleted, or otherwise invisible records return 404. Download signs a short-lived attachment URL with `application/octet-stream`.
- In `scope=mine`, `parentFolderId=root` lists only files outside folders. An explicit folder UUID must have an owned breadcrumb in the selected workspace. Omitting the filter leaves listing and search across folders.
- `ArtifactUsageService` reads the meter without creating a row. A missing row has zero usage and the default 1 GiB quota. `ARTIFACT_MAX_FILE_BYTES` is 50 MiB.
- `ArtifactUploadReservationService` and `ArtifactUploadCompletionService` are internal. A future caller must authorize the workspace and actor before calling them.

## Folder persistence

- `ArtifactFolder` stores a private workspace folder. A null `parentFolderId` places a folder or file at the workspace root. Existing files remain at the root after migration.
- Composite parent foreign keys include `workspaceId`. They reject references across workspaces and prevent deleting a folder while it contains files or child folders. Workspace deletion cascades through the whole tree. Folder operations need their own authorization and cycle checks before exposing writes.
- `ArtifactFoldersService` scopes folder reads by workspace and creator, including each ancestor in a breadcrumb. Inaccessible parents and invalid ancestry return 404. Reads allow at most 100 ancestor links, so a folder at that depth lists no children. Lists sort by name and use ID to break ties.

## File lifecycle

- Reservation allocates a UUID and signs a 15-minute POST for `workspaces/<workspaceId>/<artifactId>/upload`. It returns the form only after the pending row and quota reservation commit. The display name never contributes to an object key.
- Completion locks the workspace and owned artifact in that order, verifies the live reservation, and copies staged content to `workspaces/<workspaceId>/<artifactId>/file`. A replay of the signed form can only write to staging. Quota moves from reserved to used in the same transaction that marks the row ready. The publish helper supports retry after a copy succeeds and the database transaction rolls back.
- `ArtifactQuotaService` changes counters inside the caller's transaction with conditional updates. Keep byte values within the safe integer range. Postgres returns the stored `bigint` values as strings.
- Deletion commits the tombstone first so reads stop immediately. `ArtifactCleanupService` removes both object keys before releasing the charge and removing the row. Failed purges keep their tombstones for retry.
- `ArtifactExpirySweepService` reclaims pending reservations after their expiry plus a 15-minute grace period. It also retries tombstones. `ArtifactStagingSweepService` uses a Redis cursor to find older orphan staging writes in bounded pages.
- Workspace deletion cascades file and quota rows, then attempts prefix cleanup. The staging sweep can retry a deleted workspace's prefix when the matching successful deletion audit event still exists. Absence from the workspace table alone does not authorize cleanup of final keys.

## Verification

Use `task api:test` for service specs. The Docker e2e specs under `core-api/test` cover quota and staging policies, publication, listing, downloads, deletion, and sweep recovery against local Postgres and RustFS. Browser checks exercise the Files page with owner, manager, and read-only roles.
