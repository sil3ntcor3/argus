import { safeRedirectPath } from './safe-redirect';

/** Return to this console after verification, retaining only an in-app destination. */
export const verificationCallbackURL = (redirect?: string): string => {
  const url = new URL('/login', window.location.origin);
  url.searchParams.set('verified', '1');
  if (redirect) url.searchParams.set('redirect', safeRedirectPath(redirect));
  return url.toString();
};
