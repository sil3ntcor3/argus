# Resource discussions (Open ASM v0.12.1)

Pinned release: `961d77142671e90190bd97132638441e593bec47`. This batch uses the
previously migrated `comments` store. It adds no schema, dependency or CI
changes and preserves Argus branding and merged features.

The dedicated Comments module exposes GET/POST discussion routes for issues
and findings plus PATCH/DELETE for individual comments. Existing issue routes
and assistant automation stay disabled. Issue discussion access uses workspace
read/write; finding discussions use vulnerability read/write. Effective write
implies read. Edits/deletion additionally require authorship, current subject
write permission and mutable content flags. Workspace or permission changes
never grant access to another thread.

Bodies contain 1–10,000 characters. Replies require a live parent in the same
thread; reads also filter stale cross-thread pointers. Deleted comments are
hidden from lists while their replies retain an empty deleted-parent excerpt.
Pagination is oldest first with a stable ID tie-breaker. DTOs explicitly
project the otherwise-private finding ID and only public author identity.

Finding creation publishes `vulnerability.comment.created`; issue creation
and edits reuse their existing events. The existing non-persisted discussion
event policy applies. Payloads contain IDs and outcomes, with no bodies,
snippets or emails. No new automatic trigger event type is enabled.

Finding detail includes the discussion thread, with read-only, loading,
empty and error states. Writes serialize per workspace thread, recheck access
at dispatch, abort on workspace changes, and never queue or retry on reconnect.
Editing/deleting another comment preserves an unrelated compose draft.
Dialog cancellation restores keyboard focus; completed actions fall back to
the thread region if their original control is gone or disabled.

A lost response leaves the submitted operation locked across remounts.
Checking saved comments refreshes loaded pages; it cannot prove an uncertain
create failed on an unseen later page, so that read does not unlock retry.
Users can load more pages, review saved comments and explicitly discard the
uncertain local submission to start fresh. Discard clears only the submitted
form state, warns that the operation may already have succeeded, and never
sends it again. This is not server-side idempotency.

Deploy the API and regenerated client together after the comment-storage
foundation. Runtime rollback disables these new routes/UI without deleting
comments. Keep the storage foundation in place; its own rollback guard must
not be bypassed if finding discussions have been created.

Validate real Docker HTTP behavior for both subjects, revoked author access,
foreign IDs/replies, deletion, nullable authors, DTO limits, stable pagination
and event redaction. Validate desktop/mobile posting/reply/edit/delete,
permission controls, layout, offline behavior, duplicate submits, lost
responses and workspace switches. Run lifecycle, Templates, project AI and
Files regressions and commit the live OpenAPI/client generation together.
