# Security port rollout

This change ports the archive, authentication, encryption, audit IP, and attachment filename fixes from upstream PRs #808, #809, #810, #811 (security subset), #813, and #771 (filename helper only). It adds no database schema, dependency, generated API contract, or SMTP/settings feature.

## Before rollout

1. Take a restorable database snapshot and securely retain the exact existing encryption key configuration. Verify a restore in an isolated environment.
2. Set canonical `BETTER_AUTH_SECRET` to a separately generated random value of at least 32 characters. The API refuses to start outside development/test without it. Changing this signing secret invalidates existing signed session cookies. Better Auth aliases are not substitutes for this canonical variable.
3. Keep every existing `ENCRYPTION_KEYS` entry and append a new random key of at least 32 characters when rotating. The last entry encrypts; earlier entries decrypt only. Missing, short, and shipped example active keys are rejected outside development/test. Validation checks length and known weak values, not measured entropy.
4. Preserve the original `OASM_DEFAULT_ENCRYPTION_KEY` literal as a legacy decrypt-only compatibility key. Rebranding this value would make old stored credentials and workspace DEKs unreadable. Ciphertext markers, worker-token metadata, and persisted identifiers are also compatibility surfaces, not display text.
5. Put the deployment into maintenance mode and stop old API replicas before new replicas write data. Existing workers send their worker token on archive RPCs; upgrade custom clients that omit it.

## Data-format transition

New credentials and wrapped workspace DEKs use AES-256-GCM with stable key identifiers. Existing CBC ciphertext remains readable. CBC has no authentication: index-first lookup and plaintext shape checks improve legacy recovery but cannot prove the integrity of old ciphertext.

The boot service rewraps workspace DEKs without changing their cleartext bytes, then rewrites recognized ciphertext in:

- Agent LLM API keys and search-provider API keys.
- Integration and tool-profile configuration strings.
- Inline workflow job configurations, including the legacy job-array representation.

The service preserves unreadable values and concurrent edits. A bad workspace DEK does not stop later workspaces. Distributed locking prevents normal concurrent upgrade runs; conditional updates also protect against saves made after a row was read. Interrupted or conflicted work requires a later pass.

Plain values and unrecognized layouts are left unchanged. Counters are not proof that every possible secret is encrypted, readable, or safe to retire. Adding a new encrypted store requires extending the traversal and its regression tests. Existing decrypted execution snapshots in `jobs.config` are unchanged by this port.

## Verification

1. Inspect upgrade warnings without exposing secret values. Resolve unreadable or conflicted records and repeat the checks after any corrective action.
2. Exercise existing integrations, tool profiles, inline workflows, agent providers, first-admin bootstrap, and admin-created account login against a restored test copy.
3. Confirm unauthenticated archive calls fail, a valid worker can download its platform archives, and paths or symlinks outside the archive are refused. Archive directories must remain administrator-controlled.
4. Public HTTP `/api/auth/sign-up/email` is closed. Internal first-admin provisioning and authorized `/api/auth/admin/create-user` remain enabled. This port does not add public registration, SMTP, verification, or approval settings.
5. Configure `TRUSTED_PROXIES` with only the actual proxy addresses or constrained networks. Audit attribution uses the socket peer unless it trusts that peer, then walks the forwarded chain. An empty setting retains direct-peer attribution; historical audit rows are not rewritten.
6. Verify download names with quotes, control characters, and Unicode render safely. Malformed UTF-16 names are normalized before header encoding.

Repository checks run from the root through Task:

```bash
task lint
task test
task api:build
task api:test:e2e:one SPEC=test/auth-tenancy.e2e-spec.ts
task api:test:e2e:one SPEC=test/encryption-upgrade.e2e-spec.ts
task console:e2e:security
```

Run e2e only with explicitly isolated local infrastructure and a database ending in `_test`. Its existing harness replays the committed migrations; this port does not generate a migration. Browser checks need an isolated running API and console, with `E2E_API_URL`, `E2E_BASE_URL`, and `E2E_OUTPUT_DIR` set for that environment.

## Rollback and key retirement

An older image cannot read GCM values written by the new application. After the first new-format write or boot upgrade, rolling back only the image is unsafe. Stop all writers and restore the matching pre-upgrade database snapshot, old image, and key configuration together. Account for writes made after the snapshot before restoring it.

Keep old keys until an inventory and functional restore rehearsal establish that no retained rows, backups, exports, or other encrypted stores need them. A successful boot or zero rewrite count is insufficient. This change deliberately does not print a blanket key-retirement recommendation.
