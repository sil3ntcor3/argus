# Argus API keys module

`ApiKeysService` stores workspace MCP credentials in `api_keys`. The module has no public routes of its own. The Workspaces module exposes the current key and rotation under `workspace.apikey`.

- `McpGuard` reads the compatibility `x-oasm-api-key` header, verifies an active workspace key, and sets the workspace from its reference. Keep the header name compatible with existing clients.
- `findByKey` excludes revoked keys. The stored key is used for exact matching, so keep it out of error responses and logs. The MCP guard maps lookup failures to a generic authentication error.
- Rotation revokes active keys for the same type and reference before inserting the replacement. These are separate operations. The first read can create a key through the workspace service.
