import { isLocalEnv } from '@/common/config/runtime-env';

/** Better Auth's public fallback may only sign local sessions. */
const PUBLIC_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';
const MIN_SECRET_LENGTH = 32;

/** Refuse deployed startup with a missing, short or publicly known signing key. */
export function resolveAuthSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = env.BETTER_AUTH_SECRET || undefined;
  if (isLocalEnv(env)) return secret;
  if (
    !secret ||
    secret === PUBLIC_DEFAULT_SECRET ||
    secret.length < MIN_SECRET_LENGTH
  ) {
    throw new Error(
      `BETTER_AUTH_SECRET must be a random value of at least ${MIN_SECRET_LENGTH} characters (generate one with openssl rand -base64 32). It signs session cookies.`,
    );
  }
  return secret;
}
