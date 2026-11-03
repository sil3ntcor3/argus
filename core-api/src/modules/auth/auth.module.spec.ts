import {
  BEFORE_HOOK_KEY,
  AFTER_HOOK_KEY,
  HOOK_KEY,
} from '@/common/constants/app.constants';
import { MetadataScanner } from '@nestjs/core';
import { AuthModule } from './auth.module';

// Isolate import-time auth/transport setup; lifecycle discovery stays real.
jest.mock('./auth', () => ({ auth: {} }));
jest.mock('./auth.service', () => ({ AuthService: class {} }));
jest.mock('./user-presence.service', () => ({ UserPresenceService: class {} }));
jest.mock('better-auth/node', () => ({ toNodeHandler: jest.fn() }));
jest.mock('better-auth', () => ({
  createMiddleware: (handler: unknown) => handler,
}));
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
}));

type Context = { path: string };
type Hook = (ctx: Context) => Promise<unknown>;

class HookProvider {
  constructor(
    private readonly events: string[],
    private readonly dependency: { check: jest.Mock },
    private readonly label = 'provider',
  ) {}

  async before(ctx: Context) {
    await this.dependency.check(ctx.path);
    this.events.push(this.label + '-before');
  }

  async after(ctx: Context) {
    await this.dependency.check(ctx.path);
    this.events.push(this.label + '-after');
  }
}
Reflect.defineMetadata(HOOK_KEY, true, HookProvider);
Reflect.defineMetadata(
  BEFORE_HOOK_KEY,
  '/sign-in/email',
  HookProvider.prototype.before,
);
Reflect.defineMetadata(
  AFTER_HOOK_KEY,
  '/sign-in/email',
  HookProvider.prototype.after,
);

class UnmarkedProvider {
  before = jest.fn();
}

describe('AuthModule provider hooks', () => {
  function setup() {
    const events: string[] = [];
    const dependency = { check: jest.fn().mockResolvedValue(undefined) };
    const provider = new HookProvider(events, dependency);
    const unmarked = new UnmarkedProvider();
    const providers = [
      { metatype: HookProvider, instance: provider },
      { metatype: UnmarkedProvider, instance: unmarked },
    ];
    const discovery = { getProviders: jest.fn(() => providers) };
    const hooks: { before?: Hook; after?: Hook } = {
      before: () => {
        events.push('original-before');
        return Promise.resolve();
      },
      after: () => {
        events.push('original-after');
        return Promise.resolve();
      },
    };
    const auth = { options: { hooks: hooks as typeof hooks | undefined } };
    const module = new AuthModule(
      auth as never,
      discovery as never,
      new MetadataScanner(),
      {} as never,
      {},
    );
    return {
      module,
      auth,
      hooks,
      events,
      dependency,
      discovery,
      providers,
      unmarked,
    };
  }

  it('awaits matching before and after hooks with their injected provider instance', async () => {
    const { module, hooks, events, dependency } = setup();
    module.onModuleInit();
    await hooks.before!({ path: '/sign-in/email' });
    await hooks.after!({ path: '/sign-in/email' });
    expect(events).toEqual([
      'original-before',
      'provider-before',
      'original-after',
      'provider-after',
    ]);
    expect(dependency.check.mock.calls).toEqual([
      ['/sign-in/email'],
      ['/sign-in/email'],
    ]);
  });

  it('runs existing hooks on other paths without invoking provider hooks', async () => {
    const { module, hooks, events, dependency, unmarked } = setup();
    module.onModuleInit();
    await hooks.before!({ path: '/get-session' });
    await hooks.after!({ path: '/get-session' });
    expect(events).toEqual(['original-before', 'original-after']);
    expect(dependency.check).not.toHaveBeenCalled();
    expect(unmarked.before).not.toHaveBeenCalled();
  });

  it('retains an existing hook rejection and does not run the provider', async () => {
    const { module, hooks, dependency } = setup();
    const rejection = new Error('existing hook refused');
    hooks.before = () => Promise.reject(rejection);
    module.onModuleInit();
    await expect(hooks.before({ path: '/sign-in/email' })).rejects.toBe(
      rejection,
    );
    expect(dependency.check).not.toHaveBeenCalled();
  });

  it('propagates an asynchronous rejection from the injected dependency', async () => {
    const { module, hooks, events, dependency } = setup();
    const rejection = new Error('provider refused');
    dependency.check.mockRejectedValue(rejection);
    module.onModuleInit();
    await expect(hooks.before!({ path: '/sign-in/email' })).rejects.toBe(
      rejection,
    );
    expect(events).toEqual(['original-before']);
  });

  it('chains multiple providers in discovery order with their own dependencies', async () => {
    const { module, hooks, providers, events, dependency } = setup();
    const secondDependency = { check: jest.fn().mockResolvedValue(undefined) };
    providers.push({
      metatype: HookProvider,
      instance: new HookProvider(events, secondDependency, 'second'),
    });
    module.onModuleInit();
    await hooks.before!({ path: '/sign-in/email' });
    expect(events).toEqual([
      'original-before',
      'provider-before',
      'second-before',
    ]);
    expect(dependency.check).toHaveBeenCalledTimes(1);
    expect(secondDependency.check).toHaveBeenCalledWith('/sign-in/email');
  });

  it('leaves discovery disabled when auth has no hook configuration', () => {
    const { module, auth, discovery } = setup();
    auth.options.hooks = undefined;
    module.onModuleInit();
    expect(discovery.getProviders).not.toHaveBeenCalled();
  });
});
