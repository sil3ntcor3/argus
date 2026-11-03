// Isolate import-time policy from database, Redis and Better Auth initialization.
jest.mock('dotenv/config', () => ({}));
jest.mock('@/database/database-config', () => ({ databaseConnectionConfig: {} }));
jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('better-auth', () => ({
  betterAuth: (options: unknown) => options,
}));
jest.mock('better-auth/plugins', () => ({
  admin: jest.fn(),
  openAPI: jest.fn(),
}));
jest.mock('./session-storage', () => ({
  createSessionRedis: jest.fn(),
  createSessionStorage: jest.fn(),
}));

describe('auth startup policy', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['production', undefined])(
    'refuses to initialize deployed auth without a secret (NODE_ENV=%s)',
    (NODE_ENV) => {
      jest.replaceProperty(process, 'env', { NODE_ENV });

      expect(() =>
        jest.isolateModules(() => {
          jest.requireActual('./auth');
        }),
      ).toThrow(/BETTER_AUTH_SECRET/);
    },
  );

  it('keeps public registration closed without disabling internal signup', () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });

    jest.isolateModules(() => {
      const { auth } = jest.requireActual<{
        auth: {
          disabledPaths: string[];
          emailAndPassword: { enabled: boolean; disableSignUp?: boolean };
        };
      }>('./auth');
      expect(auth.disabledPaths).toContain('/sign-up/email');
      expect(auth.disabledPaths).not.toContain('/admin/create-user');
      expect(auth.emailAndPassword.enabled).toBe(true);
      expect(auth.emailAndPassword.disableSignUp).not.toBe(true);
    });
  });
});
