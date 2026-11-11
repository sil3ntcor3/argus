# Argus artifacts module

This module owns workspace files, quota accounting, and cleanup. The console calls the feature Files. All object keys live in the private `artifacts` bucket.

## Entry points and permissions

| Route | Selected workspace access |
| --- | --- |
| `GET /api/artifacts` | `artifact.read` for owned ready files or `scope=shared` recipient files. `scope=all` also requires `artifact.manage`. |
| `GET /api/artifacts/usage` | `artifact.read`. Returns quota, used bytes, reserved bytes, the per-file limit, and workspace-wide ready-file bytes by source and creator. |
| `GET /api/artifacts/:id` | `artifact.read` for the owner or a current named recipient in shared mode. `artifact.manage` also permits other ready-file metadata. |
| `GET /api/artifacts/:id/download` | `artifact.read` for the owner or a current named recipient in shared mode. |
| `GET /api/public/artifacts/:id` | Anonymous attachment redirect for a ready file in public mode. |
| `GET /api/artifacts/:id/shares` | Owner with `artifact.write`. Lists current workspace recipients. |
| `POST /api/artifacts/:id/shares` | Owner with `artifact.write`. Adds normalized, deduplicated workspace recipients. |
| `DELETE /api/artifacts/:id/shares/:userId` | Owner with `artifact.write`. Idempotently removes a recipient record. |
| `PATCH /api/artifacts/:id` | Owner with `artifact.write`. Selects private, shared, or public mode. |
| `DELETE /api/artifacts/:id` | `artifact.read` plus either `artifact.write` and ownership, or `artifact.manage`. |
| `GET /api/artifact-folders` | `artifact.read` for the caller's root folders or direct children of an owned `parentFolderId`. |
| `GET /api/artifact-folders/:id` | `artifact.read` and ownership of the folder and its breadcrumb. |

- `ArtifactReadService` scopes queries to the selected workspace and ready files. Foreign, pending, deleted, or otherwise invisible records return 404. Download signs a short-lived attachment URL with `application/octet-stream`.
- In `scope=mine`, `parentFolderId=root` lists only files outside folders. An explicit folder UUID must have an owned breadcrumb in the selected workspace. Omitting the filter leaves listing and search across folders. Other scopes reject folder filtering.
- `ArtifactUsageService` reads the meter without creating a row. A missing row has zero usage and the default 1 GiB quota. `ARTIFACT_MAX_FILE_BYTES` is 50 MiB.
- Usage breakdowns count ready files only. Source and creator groups sort by bytes descending with stable ties. Creator objects contain only ID, name, and image, with removed creators grouped under null. Empty workspaces return empty arrays. Meter totals can also retain charges awaiting physical cleanup.
- `ArtifactUploadReservationService` and `ArtifactUploadCompletionService` are internal. A future caller must authorize the workspace and actor before calling them.

## Sharing and audit

- Files default to private. Shared mode grants reads to named recipients who remain workspace members with `artifact.read`. Public mode grants anonymous attachment redirects. Mode changes preserve recipient records.
- Downloads use five-minute signed attachment URLs. Revocation, membership removal, and access-mode changes prevent new access when the policy no longer permits it. Issued URLs retain their original lifetime.
- Owner access-mode updates publish `artifact.updated` with the resulting mode. Recipient additions publish `artifact.shared` with shared and skipped counts. Revocations publish `artifact.unshared` with the file identity.
- Authenticated download requests publish `artifact.downloaded` when a signed URL is issued. Logical deletion publishes `artifact.deleted` when the file becomes unavailable, including when physical cleanup is deferred. Anonymous attachment redirects use the existing public download path.
- The existing audit pipeline records workspace, file, actor, and outcome. Sharing event data excludes recipient emails, file names and contents, storage keys, and signed URLs. Handler failures carry the failure outcome. Existing producer errors are logged without changing the HTTP result.

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
- The staging sweep also reclaims a ready file's staging key once its saved upload deadline passes the sweep cutoff.
- Workspace deletion cascades file and quota rows, then attempts prefix cleanup. The staging sweep can retry a deleted workspace's prefix when the matching successful deletion audit event still exists. Absence from the workspace table alone does not authorize cleanup of final keys.

## Verification

Use `task api:test` for service specs. The Docker e2e specs under `core-api/test` cover quota and staging policies, publication, listing, downloads, deletion, and sweep recovery against local Postgres and RustFS. Browser checks exercise the Files page with owner, manager, and read-only roles.
