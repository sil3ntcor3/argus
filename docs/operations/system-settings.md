# System settings API

Argus ports the backend configuration part of upstream open-asm #811
(commit 668e35606b275f5495952027e079ed67ddab6066). The existing private JSONB
columns hold the data; this batch adds no migration or dependency.

## Admin contract

Only platform admins can use GET and PATCH /api/admin/system-configs/settings.
GET fills defaults for the auth and mailServer sections and returns only their
documented fields. Passwords are write-only; hasPassword reports whether a
credential is stored. Other stored sections remain private and are preserved.

PATCH merges supplied fields within each section. Omitted and null fields retain
their saved values. An omitted, null or empty password keeps the saved credential;
a non-empty password replaces it after encryption with the active system key.
Readonly hasPassword and unknown request fields are ignored by validation.

Authentication defaults to allowSignUp: false. Mail defaults to disabled, provider
smtp, port 587 and secure: false, with empty connection/sender fields. Provider
names are presets for future clients; connection fields remain explicit.
An enabled mail configuration requires a nonblank host and sender email.
Updates lock the singleton row so validation and concurrent field merges use the
same database state. Failed validation leaves the stored settings unchanged.

These settings prepare later #811 batches. Public HTTP registration stays closed,
metadata and the login page do not advertise signup, and this batch neither sends
email nor adds mail-provider networking. Existing brand and workspace settings
continue to use their current APIs.

## Credential rotation and rollback

Mail passwords use the existing authenticated encryption format and system KEK,
independent of workspace DEKs. Keep existing ENCRYPTION_KEYS entries and append
new active keys; the last entry encrypts. The boot upgrade now traverses only
settings.mailServer.password in system_configs. It preserves other fields,
unreadable ciphertext and concurrent edits. Inspect warnings before retiring keys.
The [security port rollout](security-port-rollout.md) describes key and backup
requirements.

Rolling back this API batch can retain the additive schema and saved values.
The preceding API version does not consume these feature settings. Keep all keys needed by stored
credentials; do not revert the settings-column migration to roll back the API,
since that would permanently delete both system and workspace settings.

## Validation

Run task lint, task test, task console:test:run and task api:build from the root.
Use a disposable local database ending in _test for task api:test:e2e:one with
SPEC=test/system-settings.e2e-spec.ts, then repeat the settings-persistence,
encryption-upgrade and auth-tenancy suites. Rebuild the API, export its live
OpenAPI document, and run task gen-api to regenerate the console client.
Validate admin authorization, credential redaction, saved settings after restart,
key rotation and existing login/brand/workspace browser flows before publication.
