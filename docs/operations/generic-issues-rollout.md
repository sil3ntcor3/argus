# Generic Issues rollout (Open ASM v0.12.1)

Pinned release: `961d77142671e90190bd97132638441e593bec47`.
Preserves Argus branding, previously merged features, scanner evidence and
workspace permissions. No dependencies or CI changes.

## Upgrade and rollback

Back up Postgres and retain the prior image before upgrading. Run the approved
`AddGenericIssueTracking` migration through the normal migration service before
the API image. Existing issues, source columns, comments and valid positive
numbers remain. Duplicate/nonpositive numbers are repaired deterministically
above each workspace's previous maximum. Counters prevent number reuse after
deletion. Only verified same-workspace legacy finding sources acquire links.

The downgrade deliberately refuses when new tracking fields, issue/rule/link/
counter state or immutable system activity would be lost. Restore a verified
pre-upgrade backup for a production downgrade with new feature data; do not
force the guard or edit an applied migration. Local Docker validation includes
seeded legacy preservation, the refusal path and clean revert/re-upgrade.

## Access and operations

`/api/issues` and `/api/issues/rules` use effective workspace read/write. Links
also require the corresponding resource read permission. Finding/run references
retain Argus's tenant evidence checks, including standalone Templates runs.
Issue DTO users expose only id/name/image. Restricted generated titles are
masked both in results and search. Finding references and Target Overview use
current workspace access; private scanner proof is never returned.

Issue writes and rule changes serialize per workspace. Number allocation,
status changes and immutable activity share the transaction. The console never
queues or retries writes. An unknown outcome blocks further issue writes until
the user checks saved issues and explicitly discards the local submission.
Member enumeration retains the existing member.read gate; issue writes do not
expand member-management access. Recovery reads only issue data, and an
authoritative missing/forbidden response hides cached editors.
Workspace/issue changes drop drafts and stale callbacks; comments retain their
existing dedicated permission and recovery behavior.

## Automation

No rules are installed automatically. The explicit defaults action installs
one Critical & High remediation rule. Enabled rules only process currently open,
approved findings. Default assignees are checked again at execution time.

The new issues event lane consumes committed detected/resurfaced/fixed events.
Transport names and payloads are identifiers, never authority. Exact durable
finding proofs, retained run/source evidence and current tenant state are
validated under ordered locks. Approval proofs are distinct from scanner proof.
The issue action and private proof receipt commit together; receipts survive
issue deletion and Redis resets. A missing/deleted sibling proof cannot block
surviving findings. Large proof batches are not silently truncated.

Trusted fixes resolve work only when every linked finding is finished. A later
validated resurfacing can reopen fixed work. Newer manual decisions, expired
risk acceptances and contradictory scanner cycles are rechecked after locks.
Decision timestamps use the database statement clock in UTC. Automation does
not create scanner coverage or alter finding detection states. Audit changes
exclude title/description/comment bodies, proof and signed URLs.

## Validation

Run `task lint`, `task api:test`, `task console:test:run`, `task api:build` and
`task console:build`. Focused Issue services need at least 80 percent coverage.
Docker checks include generic issue storage/API/automation, existing comment
storage, scanner resurfacing, comparable misses and lifecycle policy. Browser
checks cover desktop/mobile CRUD, status/resolution, host linking and search,
rules, comments, read-only access, offline writes and lost creation receipts.
Retain migration, browser, model-tool and exact diff evidence with the PR.
