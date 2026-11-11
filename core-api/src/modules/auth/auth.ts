import { parseTrustedProxies } from '@/common/config/trusted-proxies';
import {
  AUTH_IGNORE_ROUTERS,
  PENDING_APPROVAL_REASON,
} from '@/common/constants/app.constants';
import { Role } from '@/common/enums/enum';
import { databaseConnectionConfig } from '@/database/database-config';
import { betterAuth, type Auth } from 'better-auth';
import { admin, openAPI } from 'better-auth/plugins';
import { randomUUID } from 'crypto';
import 'dotenv/config';
import { Pool } from 'pg';
import { resolveAuthSecret } from './auth-env';
import { logBetterAuth } from './auth-logger';
import { createSessionRedis, createSessionStorage } from './session-storage';

export const auth: unknown = betterAuth({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  database: new Pool(databaseConnectionConfig),
  // The public console origin shared with Telegram takes precedence over
  // Better Auth's legacy URL aliases. Unset locally, keep SDK fallback.
  baseURL: process.env.BASE_URL || undefined,
  secret: resolveAuthSecret(),
  logger: { log: logBetterAuth },
  // Sessions are resolved from Redis first; the database is only queried on a
  // cache miss. See session-storage.ts. The connection is its own: this
  // instance is built at import time, outside Nest DI, before RedisService.
  secondaryStorage: createSessionStorage(
    createSessionRedis(process.env.REDIS_URL),
    () => (auth as Auth).$context,
  ),
  plugins: [
    admin({
      defaultRole: Role.USER,
      adminRoles: [Role.ADMIN],
      bannedUserMessage:
        'Your account is not active. Contact your administrator.',
    }),
    openAPI({
      path: '/docs',
    }),
  ],
  trustedOrigins: ['*'],
  advanced: {
    database: {
      generateId: () => randomUUID(),
    },
    // Behind several proxies X-Forwarded-For has more than one hop; without
    // trusted proxies Better Auth cannot resolve the client and rate-limits
    // every user in one shared bucket.
    ipAddress: {
      trustedProxies: parseTrustedProxies(process.env.TRUSTED_PROXIES),
    },
    cookies: {
      session_token: {
        name: 'session',
        attributes: {
          httpOnly: true,
          // secure: true,
          // sameSite: 'strict',
        },
      },
    },
  },
  rateLimit: {
    // The limiter is 100 req / 60s in-memory. An e2e suite that signs up users
    // and fires auth guard matrices trips it and then fails on rate limit
    // instead of on the behaviour under test. Only the e2e harness sets this
    // flag (core-api/test/pin-test-env.ts); no deployed environment does.
    enabled: process.env.AUTH_RATE_LIMIT_DISABLED !== 'true',
    window: 60,
    max: 100,
    storage: 'memory',
    modelName: 'auth-rate-limit',
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    // The admin plugin's synthetic defaults would reveal an existing email:
    // real HTTP signups are pending, so duplicate responses must be too.
    customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
      ...coreFields,
      ...additionalFields,
      id,
      role: Role.USER,
      banned: true,
      banReason: PENDING_APPROVAL_REASON,
      banExpires: null,
    }),
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    expiresIn: 24 * 60 * 60,
  },
  databaseHooks: {
    user: {
      create: {
        // HTTP signup waits for approval; internal bootstrap and admin creation
        // keep their existing provisioning behavior.
        before: (user, ctx) =>
          Promise.resolve(
            ctx?.path === '/sign-up/email' && ctx.request
              ? {
                  data: {
                    ...user,
                    banned: true,
                    banReason: PENDING_APPROVAL_REASON,
                  },
                }
              : undefined,
          ),
      },
    },
  },
  // Enables Nest-discovered route hooks in AuthModule.
  hooks: {},
  session: {
    freshAge: 10,
    modelName: 'sessions',
    // Keep writing sessions to the database alongside Redis, so the database
    // stays the source of truth and a cache miss can fall back to it.
    storeSessionInDatabase: true,
  },
  // Deleting users is intentionally disabled: a user row deletion cascades
  // through `workspaces.ownerId` (ON DELETE CASCADE) and would wipe every
  // workspace they own along with all scan data. Admins ban instead.
  // `/delete-user*` (self-service) is blocked too, for the same reason.
  // `/admin/list-users` and `/admin/get-user` are replaced by GET /api/admin/users
  // and GET /api/admin/users/:id.
  // SignUpHook gates HTTP signup using system settings, closed by default.
  disabledPaths: [
    ...AUTH_IGNORE_ROUTERS,
    '/admin/remove-user',
    '/admin/list-users',
    '/admin/get-user',
    '/delete-user',
    '/delete-user/callback',
  ],
  user: {
    modelName: 'users',
    additionalFields: {
      role: {
        type: 'string',
        enum: Role,
        default: Role.USER,
      },
    },
  },
  account: {
    modelName: 'accounts',
  },
  verification: {
    modelName: 'verifications',
    // With secondaryStorage set, Better Auth would move verifications to Redis
    // too. The session storage ignores them, so they stay database-only.
    storeInDatabase: true,
  },
});
