# Connector runtime startup failures

Argus workers need a working Docker runtime for jobs that specify a container image. If runtime initialization fails, the worker stays connected so it can still process legacy command jobs. Connector jobs fail with an explicit "container engine unavailable" diagnostic containing the requested image, instead of falling through to command execution.

## Diagnose and recover

1. Expand the failed job in **Jobs Registry** and read its error logs.
2. Check the startup log of the worker identified by the job. It contains the original Docker initialization error.
3. Verify the configured Docker endpoint is reachable. For the standard container deployment, verify the Docker socket mount and its group access, and that the worker belongs to its configured connector network. On native Linux, the worker process needs access to the socket's actual group.
4. Recreate the worker after correcting the deployment configuration. For the repository's local Compose deployment, run `task docker-compose` from the repository root.
5. Submit a new scan/workflow run after recovering the worker if automatic retries have already been exhausted.

The diagnostic reports the image supplied by the connector catalogue. Published image references and OASM protocol/package identifiers retain their existing compatibility meaning.

## Deployment and rollback

Deploy the worker image containing the fix. No API deployment, generated client update, schema change, or dependency update is needed. Existing result submission, retry limits, error-log deduplication, and healthy connector execution are unchanged.

Rollback uses the previous worker image with the worker-state volume retained. Image jobs without a command return to the old misleading error; image jobs carrying a command can fall through to legacy execution again.

## Verification

Run from the repository root:

```bash
task worker:test:one PKG=./internal/worker RUN=TestProcessJobConnectorWithoutRuntime
task worker:test
task worker:test-race
task worker:lint
task worker:check
task lint
task test
```

For a local deployment check, use disposable data and a worker whose Docker runtime fails during startup. Confirm a real connector job records the image and startup-log guidance, another claim still runs, and a legacy command job still succeeds. Open the failed job's details in the browser and verify that the same diagnostic is visible after reload.
