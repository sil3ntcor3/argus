# Legacy asset additions and scope updates

Legacy `POST /api/asset-group/:id/assets` additions acquire the same owned
project row lock used by scope replacement and synchronization. The project
check, asset ownership checks, duplicate checks, and insertion use one
transaction and its repositories. A concurrent scope update commits before an
addition checks existing membership, avoiding stale duplicate decisions.

Compatibility remains unchanged: an existing membership returns 400, missing or
foreign projects/assets return 404, and mixed duplicate/new batches add nothing.
Existing rule membership is not promoted to manual membership by a legacy add.
Successful additions retain manual provenance and the existing response message.

Run `task api:test:e2e:one SPEC=test/project-membership-add.e2e-spec.ts` against a
disposable local database for the lock regression. It observes PostgreSQL's
actual lock wait while a scope transaction removes an old rule membership, then
checks that the waiting add creates a manual membership after that commit.
`project-membership-uniqueness.e2e-spec.ts` additionally checks concurrent adds
and rollback after a deliberately stale duplicate precheck.
