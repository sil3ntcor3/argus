# Initial project finding attribution

This batch ports the initial finding-link write from upstream open-asm #826.
When vulnerability ingestion inserts or updates a finding, it creates the
project/finding link in the same PostgreSQL transaction. An existing workspace
finding can gain a link to another project without creating a second finding.

The writer resolves the project from the persisted job and run, including when
normal ORM reads hide `projectId`. The finding must match the stored job's asset
and tool, and the project, workflow and asset target must share a workspace.
Standalone runs and inconsistent legacy ownership produce no project link.
Values supplied on an in-memory job history cannot override persisted identity.

Each new link starts with count 1, the reporting run as both run references,
and transaction time as both sighting timestamps. The unique project/finding
constraint and `ON CONFLICT DO NOTHING` make duplicate and concurrent initial
reports safe. Any subsequent ingestion failure rolls back both the finding and
its new link. Existing links, including historical backfills, stay unchanged.

This is an initial-attribution foundation: repeats do not yet refresh last-seen
references/timestamps or increment counts. Those fields describe the initial
recorded sighting until repeat tracking is ported. The upstream transition-based
counter needs a separate decision for interleaved runs; it cannot reliably
count distinct runs when reports arrive A, B, A. No inference from those partial
counts is introduced here.

Existing finding APIs, filters, events, notifications and Argus UI keep their
contracts. No migration, dependency or generated API change is needed. Use
`task api:test:e2e:one SPEC=test/project-finding-links.e2e-spec.ts` for persisted
identity, existing findings, retries, concurrency, tenant isolation and rollback.
Synthetic completed jobs supply results; no scanner execution is required.

For application rollback, deploy the previous API image without reverting
migrations. Saved links remain available; the previous image simply creates no
additional links. Keep the existing provenance schema in place.
