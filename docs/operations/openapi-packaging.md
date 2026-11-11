# API authentication documentation packaging

The API image includes the existing tracked `.open-api/better-auth.json` fragment at `/app/resources/openapi/better-auth.json`. Docker copies it unchanged during the final image stage; no second source copy is tracked under `core-api/resources`.

The spec merger prefers this packaged resource and resolves it relative to its module, independently of the working directory. Source and locally compiled execution retain the existing checkout `.open-api/better-auth.json` fallback.

## Behavior and compatibility

- Container startup merges the existing authentication paths, schemas and security definitions into the API document served at `/api/docs` and written to `.open-api/open-api.json`.
- Existing OpenAPI normalization, tags and domain paths are preserved. Authentication routes, policy and generated client contracts are unchanged.
- If neither fragment exists, the merger retains its earlier behavior and returns the domain document. A present but malformed fragment still fails parsing rather than silently using a different copy.
- The tracked generated files remain in place. Generate them through the repository workflow; do not hand-edit them.

## Deployment and validation

Build and deploy the API image normally. No database migration, dependency, environment variable or console deployment is required. Rebuild the API image after an approved update to the canonical auth fragment so its runtime copy stays in sync. Rolling back changes documentation packaging only; stored data formats are unaffected.

From the repository root:

```bash
task api:test:one SPEC=src/utils/mergeBetterAuth.spec.ts
task lint
task test
task console:test:run
task api:build
task console:build
# After a fresh API boot has generated the combined spec:
task gen-api
```

For Docker validation, start the stock image without a host auth-spec mount. Check that its packaged fragment matches the tracked input byte-for-byte, that all auth paths survive generation, and that normal client generation produces no unrelated type removals. Open `/api/docs` in a browser and inspect both authentication and domain documentation; also smoke-test console login and session reload.
