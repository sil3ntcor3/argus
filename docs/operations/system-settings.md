# System settings API

Argus ports the backend configuration part of upstream open-asm #811
(commit 668e35606b275f5495952027e079ed67ddab6066). The existing private JSONB
columns hold the data. The SMTP foundation adds nodemailer 10.2.1, with no
additional migration.

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
metadata and the login page do not advertise signup, and no HTTP endpoint or
authentication hook invokes mail delivery. Existing brand and workspace settings
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

## Internal SMTP transport

The internal MailService reads saved settings for every message and refuses to
connect while mail is disabled. Its send method accepts a recipient, subject,
plain text and optional HTML. It decrypts the password only for transport,
retaining ciphertext in storage. A blank username omits SMTP authentication;
an omitted password with a username supplies an empty password.

An explicit fromName wins; otherwise the saved system name is used (Argus by
default). The transport uses the configured host, port and secure flag, with
10-second connection/greeting timeouts and a 20-second idle socket timeout.
Normal TLS certificate validation and STARTTLS behavior remain enabled. Each
send closes its transport on success or failure, and delivery errors propagate
to the internal caller. This service has no boot-time sending behavior.

Provider names remain labels; the explicit SMTP fields control delivery.
The mail-test endpoint, mail settings UI and signup/verification wiring belong
to later batches. Validate this foundation against a disposable local SMTP sink;
never use real recipient addresses or production credentials for smoke tests.
Rolling back the API can retain saved settings and keys without reverting schema.
