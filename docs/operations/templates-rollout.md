# Custom Nuclei templates

This ports Open ASM v0.12.1 #804. The Templates workspace settings tab uses
private, quota-accounted artifacts and immutable YAML revisions. Existing
Argus Files, project context and conversation behavior remain available.
The later template generator is outside this release boundary.

## Deployment and legacy import

1. Back up PostgreSQL and the legacy `nuclei-templates` bucket. Keep the
   `AllowTemplateArtifactRevisions` migration applied. This batch adds no schema.
2. Pause template writes during cutover and let every old presigned upload URL
   expire. The importer must not race a late legacy upload. Deploy the API and
   console together: the old direct-upload Templates operations are replaced.
3. Preview from the repository root with the intended database/storage settings:

   ```bash
   task api:templates:import
   # Optional single-workspace preview:
   task api:templates:import -- --workspace=<workspace-uuid>
   ```

4. Review the ID/workspace/status report. Apply only after legacy uploads drain:

   ```bash
   task api:templates:import -- --apply --legacy-uploads-drained
   ```

5. Confirm imported IDs, names, exact bytes (including a UTF-8 BOM), owners,
   sharing and quota. Verify a local template run before restoring normal writes.

The maintenance command starts no API consumers, schedules or migrations.
It never deletes or changes legacy rows/objects. Valid templates retain their
IDs and names and become private files owned by the current workspace owner.
Invalid/oversized/missing originals, unavailable owners, unsupported paths,
identity collisions and changed originals are reported; they are not overwritten.
Existing imported artifacts are recognized even after a user edits their copy.

An immutable private marker under
`workspaces/<workspace>/template-imports/<legacy-id>` is claimed before an
import publishes a file. It prevents maintenance reruns from recreating a file
that the user deleted. Markers are operational metadata, outside file quota;
retain them with storage backups. They are removed with workspace storage.
`previous_import_attempt`, `pending_recovery` or `write_failed` require review:
inspect the report, pending expiry and byte accounting before an operator
repairs an interrupted import. Never blindly remove markers to retry.

Rollback preserves original rows/objects, but an older API cannot serve new
template artifacts. Export new/edited templates before reverting application
images. The schema rollback refuses template artifacts rather than discard them.

## Runtime and access

Templates require artifact read access. Creates/edits/renames require artifact
write and ownership. Sharing/deletion use the existing file APIs. A run also
requires vulnerability write, installed Nuclei and one nonempty workspace-scoped
target, asset or project selection. Project scope uses enabled member assets.
Unavailable IDs are rejected; no request broadens to all assets or builtin templates.

Jobs store a private template-ID/actor selector, never signed URLs. Claims check
current membership/permissions and file access again, then sign the current
immutable keys for one hour. Scan identity uses immutable content identities,
not changing signatures. A revoked/deleted/unreadable selection fails its exact
claim and is omitted from dispatch. Standalone template runs have workspace-scoped
Runs detail and close under the normal run lock after their jobs settle.
Generic per-job rerun is refused for these jobs; start a fresh run in Templates
so it uses the requesting member's current access rather than another actor's.

For same-origin storage proxy deployments, set `BASE_URL` to the public console
URL reachable by connector containers. Absolute S3 deployments use the configured
public S3 endpoint. Browser-relative URLs must not be handed directly to connectors.
The configured upstream Nuclei connector must support `customTemplates` (#15);
an older locally cached image under the same tag can ignore this field. Validate
the image digest before rollout. Keep external connector image namespaces intact
until corresponding Argus images have been published and verified.

Retirement starts after the committed pointer change is observed. Superseded
revisions remain for at least 75 minutes, longer than the one-hour worker URLs.
Keep the revision sweep enabled and its private retirement metadata intact.

The existing `run_tool_connector` conversation tool additionally accepts up to
20 inline Nuclei YAML documents, at most 64 KiB total. These apply only to that
invocation and use existing permissions, approvals, timeouts and cancellation.
They create no files, assets or findings. No later saved-template generation
tool is introduced.

## Validation

```bash
task lint
task test
task console:test:run
task api:build
task console:build
task api:test:e2e:one SPEC=test/templates-api.e2e-spec.ts
task api:test:e2e:one SPEC=test/template-runs.e2e-spec.ts
task api:test:e2e:one SPEC=test/legacy-template-import.e2e-spec.ts
```

Use dedicated local Docker Postgres/Redis/RustFS for integration tests; do not
share an artifacts bucket between independent databases. Exercise desktop/mobile
create/upload/edit/format/rename/share/run, permission loss, stale-read failures,
offline behavior and pending writes across tab/workspace changes. Confirm that
an unavailable custom template fails without running the builtin collection.
