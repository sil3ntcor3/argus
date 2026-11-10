# Argus live events module

`GET /api/events/stream` is the console's authenticated Server-Sent Events connection. It combines per-user notification pushes with allowlisted events for one workspace.

- `EventsWorkspaceGuard` uses only `X-Workspace-Id`. The `wid` cookie is shared across tabs and cannot choose the stream workspace. No header gives a notifications-only stream. Validate membership before SSE headers are sent so an invalid UUID returns 400 and an inaccessible workspace returns 403.
- `CLIENT_EVENTS` allows `notification.*`, `worker.*`, `target.*`, and `workflow.*`. A workspace member sees event pointers and refetches data through permission-checked REST endpoints. Keep actor, IP, changes, and payload out of the browser stream. The optional `joinKeyId` is a public alias on `worker.joined`.
- The service sends a `ping` heartbeat every 25 seconds. Each replica uses one `XREAD` loop from the current end of the stream while workspace listeners are connected. The live stream does not replay missed events. Notification pushes use a separate `PSUBSCRIBE notification:*`, routed by user ID.
- Keep the event-bridge codec and notification channel format compatible with the stream. The controller and service specs cover workspace resolution, allowlisting, fan-out, and subscription lifecycle.
