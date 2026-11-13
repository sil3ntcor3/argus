# Argus Templates module

The public `TemplatesController` and `TemplatesService` currently use the legacy `templates` table and `nuclei-templates` bucket. Their API/UI cutover is separate from the storage foundation below. Keep legacy rows and objects for the approved data-preserving import.

## Private artifact writer

- `TemplateArtifactService` creates private, requester-owned `template` artifacts in the workspace's reserved root `custom-templates` folder. That folder has no creator and is not a personal Files folder. Creation serializes the folder lookup/insert under the workspace lock.
- Callers authorize current workspace membership and the action before invoking the writer. Content replacement also checks owner, ready state, source, and reserved-folder identity under the artifact lock. Source alone does not identify a template.
- `validateTemplate` enforces YAML display names, a 256 KiB UTF-8 byte limit, and a single YAML mapping with a nonblank string `id`. The existing parser rejects duplicate keys, multiple documents and executable tags. This validates storage input, not scan safety or the complete Nuclei schema.
- Creation reuses artifact reservation, staging, immutable final publication, quota settlement and expiry recovery. Failed writes retain a charged pending record for the existing expiry sweep.
- Edits lock workspace, artifact and meter in that order, adjust logical quota transactionally, and publish a fresh UUID revision with an S3 create-only precondition. They atomically update the artifact pointer and size while retaining its ID, name and sharing state. A failed transaction preserves the prior content and charge.
- The pointer transaction also records the prior object suffix as awaiting retirement observation. The sweep starts each retirement clock only after commit is visible; frequent edits do not reset earlier clocks. Preserve this private metadata when importing or copying template records.
- Writes have a 15-second I/O deadline and check cancellation before publication commits. Audit events publish after commit and exclude names, YAML, storage keys and URLs.
- `TemplateRevisionSweepService` in the artifacts module owns retirement cleanup. Keep it enabled whenever revision writes are enabled. See the [artifacts guide](../artifacts/AGENTS.md).

## Verification

Use `task api:test:one SPEC=src/modules/templates/template-validation.spec.ts` and `task api:test:e2e:one SPEC=test/template-artifact-content.e2e-spec.ts`. The latter needs dedicated local Docker Postgres/Redis/RustFS. Each database must have its own artifacts bucket; test and browser deployments must not share one. Full lint, API/console tests, code generation after DTO changes, and browser checks still apply.
