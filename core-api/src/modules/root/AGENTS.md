# Argus root module

`RootController` serves public health, metadata, and latest version routes under `/api`. `RootService` reads initialization and system settings for console bootstrap.

- Metadata shows effective signup availability only when the saved preference and mail are enabled. Expose only the public settings view and preserve the current branding and version sources.
- Health is used for Docker readiness. Latest version reads the Redis `version:latest` entry and compares it with `APP_VERSION` outside development. Keep public boot routes usable before workspace selection.
- Use `root.service.spec.ts` and the startup/browser smoke tests for bootstrap changes.
