# Argus providers module

`ProvidersService` handles user-owned `ToolProvider` records under `/api/providers`. These records describe tool providers. They are separate from the LLM connections in AI Studio.

- Scope reads and changes to the authenticated owner. Tool relationships use the provider entity, so check those relationships before changing ownership or removal.
- Use `providers.service.spec.ts` for ownership checks.
