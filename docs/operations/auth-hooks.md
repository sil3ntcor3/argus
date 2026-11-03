# Auth provider hooks

The Nest auth module discovers providers marked with `@Hook()` and registers their `@BeforeHook(path)` and `@AfterHook(path)` methods through Better Auth's auth-aware middleware factory.

## Invocation behavior

- Each decorated method runs with its provider instance as `this`, so injected services are available.
- The existing hook runs first; matching provider hooks then run in discovery order.
- Hooks match the exact auth-relative path, such as `/sign-in/email`.
- Asynchronous work is awaited and rejections propagate. An existing hook rejection prevents later provider invocation.
- Providers without `@Hook()` are ignored. If the auth options have no `hooks` configuration, discovery remains disabled.

This fix corrects existing integration wiring. It does not enable new production hook providers or change login, signup, verification, or administrator-approval policy. Public signup remains closed under the existing configuration.

## Deployment and validation

Deploy the API normally. No migration, dependency, environment-variable, public-contract, or client-generation change is required. API rollback restores the earlier hook wiring; no stored data format changes.

Run from the repository root:

```bash
task api:test:one SPEC=src/modules/auth/auth.module.spec.ts
task lint
task test
task console:test:run
task api:build
task console:build
```

For a local Docker rehearsal, use a disposable database and test-only hook provider with an injected service. Exercise a real sign-in before/after hook, rejection, session reload, and sign-out. Compare with a stock API instance without hooks. Keep fixture providers, diagnostics, credentials, and validation entrypoints outside production source.
