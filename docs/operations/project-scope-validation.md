# Workspace-aware project scope validation

The internal scope normalizer prepares rule preview and saving. It validates
include/exclude modes and type-specific values before querying references, then
checks target IDs and asset ownership against the requested workspace. Missing
and foreign references receive the same validation error without foreign labels.

UUID arrays are bound in at most two queries. Duplicate canonical mode/type/value
triples collapse while different modes and first-input order remain intact. Empty
rules and hostname/CIDR-only rules require no reference queries. Database failures
propagate rather than being reported as bad rule input.

This service does not save rules or change membership. Public request limits,
project authorization, preview and rule-management routes follow separately.
No schema, dependency or API generation changes are needed for this foundation.
