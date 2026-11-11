# Argus remote execution module

`RemoteExecuteService` sends a shell command or connector request to a selected worker and waits for its result. It exposes no HTTP or gRPC routes of its own. The workers module owns stream and result transport.

- Keep workspace and conversation selection with the caller, and use the worker stream's current assignment when handling results. Register the response listener before sending a command so an immediate result is observed.
- Preserve timeout, cancellation, and bounded output handling. The connector output cap is `REMOTE_OUTPUT_MAX_CHARS`.

Use `remote-execute.service.spec.ts` with fake workers and streams. Validate routing alongside the worker stream and agent approval tests.
