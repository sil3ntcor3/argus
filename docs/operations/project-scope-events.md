# Scope-edit membership reports

Successful scope replacement publishes `project.assets.added` after its locked
transaction commits, with only the membership IDs newly inserted by that write.
The workspace, canonical project ID and project subject identify the change;
there is no originating scan run. Other connections can see the stored rules,
preferences and memberships before publication.

Empty additions, repeated replacements, removal-only writes and failed or
rolled-back transactions publish no addition fact. Manual members retain their
provenance. The existing scope response still contains numeric counts only, and
the controller retains the request actor and scope counts in project activity.
The bridge remains best-effort after commit; no transactional outbox is added.
Later event-trigger batches can consume this fact without treating removals or
unchanged memberships as new discoveries.
