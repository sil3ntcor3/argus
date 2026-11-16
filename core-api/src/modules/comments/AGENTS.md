# Resource discussions

- This module registers only six dedicated comment routes. Keep the retired
  `IssuesController` and issue-assistant automation disabled.
- Resolve the subject in the selected workspace before every operation.
  Issues require workspace read/write; findings require vulnerability
  read/write. PATCH/DELETE require both authorship and the subject's effective
  write permission, plus the stored edit/delete flags. System entries cannot
  be mutated through these routes.
- `IssueComment` intentionally still names the shared `comments` entity.
  Its private `vulnerabilityId` is `select: false`: explicitly project it only
  inside authorized discussion reads and return dedicated DTOs. Author data
  exposes only ID, name and image.
- Validate replies against the same live subject. Every reply join must also
  filter by subject so stale stored pointers cannot disclose another thread.
  Soft-deleted parents have an empty excerpt and a deleted marker.
- Comment events carry resource/comment/actor IDs, never content or emails.
  The new finding event follows the existing non-persisted comment policy.

Use real HTTP/Postgres tests for tenant boundaries, revoked access, foreign
replies, deletion and pagination. See `docs/operations/resource-discussions-rollout.md`.
