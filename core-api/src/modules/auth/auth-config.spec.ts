// Isolate import-time policy from database, Redis and Better Auth initialization.
jest.mock('dotenv/config', () => ({}));
jest.mock('@/database/database-config', () => ({
  databaseConnectionConfig: {},
}));
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

  it('routes signup through hooks without signing new users in', () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });

    jest.isolateModules(() => {
      const { auth } = jest.requireActual<{
        auth: {
          disabledPaths: string[];
          emailAndPassword: {
            enabled: boolean;
            disableSignUp?: boolean;
            autoSignIn?: boolean;
          };
          emailVerification: {
            sendOnSignUp: boolean;
            autoSignInAfterVerification: boolean;
            expiresIn: number;
          };
          hooks?: object;
        };
      }>('./auth');
      expect(auth.disabledPaths).not.toContain('/sign-up/email');
      expect(auth.disabledPaths).not.toContain('/admin/create-user');
      expect(auth.emailAndPassword.enabled).toBe(true);
      expect(auth.emailAndPassword.disableSignUp).not.toBe(true);
      expect(auth.emailAndPassword.autoSignIn).toBe(false);
      expect(auth.emailVerification).toEqual({
        sendOnSignUp: true,
        autoSignInAfterVerification: false,
        expiresIn: 86400,
      });
      expect(auth.hooks).toEqual({});
    });
  });
  it.each([undefined, '', 'https://argus.example.test'])(
    'uses the canonical BASE_URL option when set (BASE_URL=%s)',
    (BASE_URL) => {
      jest.replaceProperty(process, 'env', {
        NODE_ENV: 'test',
        ...(BASE_URL === undefined ? {} : { BASE_URL }),
        BETTER_AUTH_URL: 'https://legacy.example.test',
      });
      jest.isolateModules(() => {
        const { auth } = jest.requireActual<{
          auth: { baseURL?: string; logger?: { log?: unknown } };
        }>('./auth');
        expect(auth.baseURL).toBe(BASE_URL || undefined);
        expect(auth.logger?.log).toEqual(expect.any(Function));
      });
    },
  );
});
