import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './safe-redirect';
import { verificationCallbackURL } from './verification-url';

describe('verification return paths', () => {
  it.each([
    undefined,
    '',
    'https://outside.example',
    '//outside.example',
    '/\\outside.example',
    '/\n/outside.example',
    '/\t/outside.example',
    '/\u007f',
  ])('rejects an unsafe return path %j', (path) => {
    expect(safeRedirectPath(path)).toBe('/');
    const callback = new URL(verificationCallbackURL(path));
    expect(callback.origin).toBe(window.location.origin);
    expect(callback.pathname).toBe('/login');
    expect(callback.searchParams.get('redirect')).toBe(path ? '/' : null);
  });

  it.each(['/', '/assets?view=all#results'])(
    'retains an in-app return path %s',
    (path) => {
      expect(safeRedirectPath(path)).toBe(path);
      const callback = new URL(verificationCallbackURL(path));
      expect(callback.searchParams.get('verified')).toBe('1');
      expect(callback.searchParams.get('redirect')).toBe(path);
    },
  );
});
