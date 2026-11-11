# Argus technology module

`TechnologyForwarderService` enriches detected names with catalog data and icon URLs for assets and statistics. The service caches catalog entries in Redis and puts icons in `cached-static`. This module has no database tables or HTTP routes.

- Preserve cached catalog entries when re-running the initialization path. The icon URL is returned through the storage service, which owns public-policy verification and signing fallback.
- Use `technology-forwarder.service.spec.ts` to check cache behavior with mocked Redis and storage.
