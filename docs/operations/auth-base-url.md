# Authentication base URL

Argus passes the existing `BASE_URL` setting explicitly to Better Auth. Set it to the public console origin, including the scheme and no `/api` suffix, for example `https://argus.example.com`. The SDK appends its auth path (`/api/auth`). This setting is shared with Telegram webhook configuration.

## Configure and verify

1. Set `BASE_URL` in the API deployment environment (or `core-api/.env` locally). Keep `BETTER_AUTH_SECRET` and the encryption keys unchanged.
2. Restart or recreate the API so its import-time auth configuration sees the setting. In the local Compose deployment, pass it into the API container environment; a host-only variable does not configure an already running container.
3. Sign in through the public console, reload, and confirm the session still resolves. Confirm an authenticated visit to `/login?redirect=%2Fworkspaces` returns to the workspace page.
4. Confirm startup does not report a missing auth base URL. Existing sessions remain signed with the same secret; this change does not rotate it.

When `BASE_URL` is nonempty it wins over legacy Better Auth URL aliases such as `BETTER_AUTH_URL`. With it unset or empty, the SDK retains its existing fallback behavior, including URL aliases and the request host. Local development and tests suppress only the known missing-base-URL warning. Deployed instances (including an unset `NODE_ENV`) log an actionable `BASE_URL` warning through Nest. Other auth log messages retain their severity and arguments.

Keep the resolved origin and cookie policy consistent across API replicas. Better Auth can change secure-cookie names when switching schemes, or between explicit HTTP and production request-host fallback. Such a change requires a fresh sign-in even though the signing secret is unchanged.

Configuring `BASE_URL` also enables Telegram webhook mode instead of polling. Use the public origin that reaches the API through the console proxy for both services.

This batch keeps public registration closed. It does not enable verification emails, SMTP, signup approvals, or account settings.
