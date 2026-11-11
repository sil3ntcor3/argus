/** Preserve in-app return paths; reject external URLs, backslashes and controls. */
export const safeRedirectPath = (redirect?: string): string =>
  redirect?.startsWith('/') &&
  !redirect.startsWith('//') &&
  !redirect.includes('\\') &&
  ![...redirect].some((character) => character < ' ' || character === '\u007f')
    ? redirect
    : '/';
