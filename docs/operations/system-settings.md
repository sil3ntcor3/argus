# System settings API

Argus ports system settings and the backend signup flow from upstream open-asm #811
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

Public HTTP registration is closed by default and requires both allowSignUp
and an enabled mail server. Public metadata reports the effective eligibility
to the login and signup pages. Saving settings alone sends no
message. Existing brand and workspace settings retain their current APIs.

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
Configure and test the saved server through /admin/mail-server.
Validate this foundation against a disposable local SMTP sink;
never use real recipient addresses or production credentials for smoke tests.
Rolling back the API can retain saved settings and keys without reverting schema.

## Admin mail test

POST /api/admin/system-configs/settings/mail-server/test requires a platform
administrator session and a JSON body such as {"to":"admin@example.com"}.
It sends one message through the saved SMTP server. Recipient validation rejects
missing, null, empty, malformed, array and header-injection values. Additional
message or SMTP fields in the request are ignored; they cannot override the
stored server, sender, subject or body.

Success returns HTTP 201 with {"message":"Test email sent"}. Anonymous callers
receive 401 and non-admin users receive 403, before delivery is attempted.
Invalid recipients receive 400. Disabled mail and delivery failures return 400
with "Test email failed. Check the mail server settings." Raw SMTP errors and
credentials are not returned. The subject and text use the saved system name;
the sender still follows the configured fromName or the saved name (Argus by
default). Sending a test never changes saved settings or enables registration.

Validate using only a local Docker SMTP sink with synthetic credentials and
recipients. Cover real admin delivery, denied callers, invalid recipients,
disabled mail, connection refusal, credential redaction and retained ciphertext.
Regenerate both OpenAPI documents and the console client using task gen-api
after starting the new API. Existing routes and schemas must remain unchanged.

## Signup, verification and approval

A previously saved allowSignUp: true becomes active once this batch is deployed
with mail enabled. Save allowSignUp: false before upgrading if registration
should remain closed.

POST /api/auth/sign-up/email returns 403 with "Sign-up is disabled" unless both
auth.allowSignUp and mailServer.enabled are true. When open, Better Auth creates
a normal user with banned: true and banReason: "Pending approval". It returns
no session and sends a verification link through the saved SMTP server. The link
expires after 24 hours. Verification marks the email confirmed without signing
the user in or approving the account. HTML mail escapes names and link attributes;
plain text retains the complete link and uses Argus or the saved custom name.

Before confirmation, correct-password sign-in returns EMAIL_NOT_VERIFIED. Wrong
passwords retain INVALID_EMAIL_OR_PASSWORD. After confirmation, sign-in returns
BANNED_USER until a platform administrator approves using the existing
POST /api/auth/admin/unban-user endpoint. The verification check only looks up
the target after an admin session is established. Anonymous and non-admin
callers retain Better Auth's authorization errors. Ordinary bans are unaffected.

While mail is enabled, pending accounts must verify before approval. If an admin
disables mail, approval can proceed without verification, matching upstream's
manual recovery behavior. Disabling signup alone prevents new accounts without
blocking existing verification links or approval. Server-side first-admin setup
and admin-created accounts stay outside the public-signup approval path.

Delivery failure leaves the account pending and logs a generic message without
SMTP details or verification tokens. POST /api/auth/send-verification-email can
retry delivery; existing and unknown addresses receive the same success shape.
Validate signup, resend, invalid links, authorization and login against local
Docker Mailpit using task api:test:e2e:one SPEC=test/signup-approval.e2e-spec.ts.
To close registration, save auth.allowSignUp: false. Pending accounts remain
banned after rollback; administrators can review them through existing user
management. Retain saved SMTP credentials and encryption keys.

## Pending account review

Admin user tables and detail pages show Pending approval for banned accounts
whose existing banReason is "Pending approval". The Edit tab offers Approve via
the existing unban endpoint. Unverified accounts wait while mail is enabled;
loading or failed settings keep approval disabled and provide Retry. With mail
disabled, administrators can approve manually. Ordinary ban controls remain for
other accounts. The backend enforces email verification before approval while
mail is enabled.
The approval UI continues to use the existing unban endpoint.

## Authentication preference

The admin Authentication page at /admin/authentication manages the existing
settings.auth.allowSignUp preference through the settings API. It saves only the
auth section and refreshes the settings and metadata caches. Loading or failed
reads keep the switch unavailable; failed saves retain the saved value. The page
links to mail settings when email verification mail is disabled.

The preference controls port upstream #811 (668e3560). Public registration
requires both this preference and enabled mail. Public metadata exposes that
eligibility to the login and signup pages. Saving this preference sends no email. Rollback
can retain the saved setting and schema.

## Public signup metadata

GET /api/metadata includes allowSignUp as a boolean, without authentication or
workspace context. It is true only when both auth.allowSignUp and
mailServer.enabled are true. Eligibility is read after configuration
initialization on every request, so later setting changes appear on the next
read. Mail settings, credentials and private settings remain absent.

This additive response field ports upstream #811 (668e3560). Existing clients
can ignore it; registration remains enforced by the signup endpoint. Cached
metadata is a discovery hint and must not authorize registration. Rollback can
omit this field without a schema change.

## Login verification recovery

The login page ports verification recovery from upstream #811 (668e3560).
An EMAIL_NOT_VERIFIED sign-in response offers Send the verification email again
for that attempted address, using the existing send-verification-email endpoint.
Resend and sign-in are disabled while delivery is pending; failures permit retry.
A new sign-in attempt clears the previous resend target. Other credential and
ban errors keep their existing behavior and do not offer resend.

Verification links return to the same console's /login?verified=1 and retain
only an in-app redirect. The confirmation message still requires administrator
approval; invalid or expired links show recovery guidance. Query markers only
control messages and cannot verify or approve an account. Validate resend and
the verification-to-approval login flow against local Docker Mailpit. No API or
schema change is required.

## Public registration UI

The login page shows Sign up only after a successful fresh eligibility read.
/signup refreshes metadata even after preloading or restoring a query cache.
While availability is loading, failed or closed, it offers no registration form;
failed reads can be retried. Signed-in visitors return to a safe in-app path,
and a fresh installation still redirects to first-admin setup.

The form validates a trimmed 1–100 character name, email, an 8–128 character
password and matching confirmation. It uses the existing signup endpoint and
same-origin verification callback, then returns to login without creating a
session. Duplicate addresses retain the backend's identical response behavior.
Concurrent submissions are disabled; request failures permit retry. A 403
refreshes eligibility so closing registration replaces the form with a notice.
The backend remains authoritative for signup, verification and approval.

Run task console:routes after route changes, then task console:build. The routes
task invokes the configured Vite generator; never edit routeTree.gen.ts manually.
Validate the complete registration-to-approval flow on desktop and mobile with
local Docker Mailpit, including cached metadata, closure, failures and retry.
This UI port completes upstream #811's signup flow without API or schema changes.
Rolling back the UI leaves existing accounts, settings and approval controls intact.
