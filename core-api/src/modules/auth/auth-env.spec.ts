import { resolveAuthSecret } from './auth-env';

const strongSecret = 'f3Jq9vX2mR7tL0pK8sW4nB6yH1cD5eZaU+oQ=';

describe('resolveAuthSecret', () => {
  it.each(['production', 'staging', undefined])(
    'accepts a configured secret when deployed (NODE_ENV=%s)',
    (NODE_ENV) => {
      expect(
        resolveAuthSecret({ NODE_ENV, BETTER_AUTH_SECRET: strongSecret }),
      ).toBe(strongSecret);
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'short-secret'],
    ["Better Auth's public default", 'better-auth-secret-12345678901234567890'],
  ])('rejects a %s deployed secret', (_, BETTER_AUTH_SECRET) => {
    expect(() => resolveAuthSecret({ BETTER_AUTH_SECRET })).toThrow(
      /BETTER_AUTH_SECRET must be a random value of at least 32 characters/,
    );
  });

  it('requires the canonical secret even if an alias is set', () => {
    expect(() => resolveAuthSecret({ AUTH_SECRET: strongSecret })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it.each(['development', 'test'])('allows local defaults in %s', (NODE_ENV) => {
    expect(resolveAuthSecret({ NODE_ENV })).toBeUndefined();
    expect(resolveAuthSecret({ NODE_ENV, BETTER_AUTH_SECRET: '' })).toBeUndefined();
    expect(resolveAuthSecret({ NODE_ENV, BETTER_AUTH_SECRET: 'local' })).toBe(
      'local',
    );
  });
});
