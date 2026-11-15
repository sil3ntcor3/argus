# Finding search

This Open ASM v0.12.1 port adds approved finding previews to Argus search. It uses existing storage and permissions; no migration or dependency change is needed.

## HTTP behavior

GET /api/search retains the selected workspace and both existing asset/target read requirements. Its new optional severity query accepts one or up to five repeated recognized values and applies only to findings. Unknown or malformed values return 400.

The response adds data.vulnerabilities: at most five records containing id, name, severity, nullable affectedUrl and an asset id/value reference. The query matches name, CVE IDs or affected URL case-insensitively, treating LIKE wildcards literally. It sorts by creation time descending and ID descending for stable ties. Approved fixed, dismissed and archived findings remain searchable; pending/rejected proposals do not.

Effective vulnerability read access is independent of base search access. Without it, ordinary search returns an empty finding preview. An explicit severity filter returns 403. Results are private and non-cacheable, with no proof, scanner fields or source/conversation metadata.

The finding list is a preview rather than a paginated full result set. Existing total, page, limit, pageCount and hasNextPage continue describing target/asset results. The console identifies finding previews separately and does not imply that five is a full matching total. The preview remains the newest five on later target/asset pages.

Severity-only requests use value="". The console client preserves that required empty parameter only for GET /api/search with severity. Its existing parameter cleanup stays in effect elsewhere. Nonblank parsed search text keeps the existing user-owned history format; severity-only requests do not create empty history entries.

## Console

The command palette and full search page show finding name, severity and affected URL or asset context, with links to the existing finding detail page. The search page adds a Findings tab and an accessible severity control.

Severity tokens such as severity:critical become filters. Other recognized release prefixes (host, port, tech, status, tag and cve) become ordinary search text rather than additional structured filters. Unknown prefixes and invalid severity tokens remain literal text. Original query syntax stays in the existing query URL; choosing a new severity replaces recognized severity tokens and resets the target/asset page.

Argus navigation destinations, page jumping, keyboard controls, Escape/focus return, history controls, branding and merged extras remain in place. Caches are scoped to workspace and finding access; permission refresh, denial and changed input suppress prior sensitive results. A new palette opening requires a fresh result.

## Validation and rollback

Use task test, task lint, task console:test:run, API/console builds and task gen-api. The finding-search Docker HTTP suite checks matching, literal text, stable cap, approval/tenant/permission gates, safe fields, pagination and history ownership. Browser validation uses the rebuilt local Docker API/console on desktop and mobile for search, filtering, reload, keyboard/focus, navigation, empty/error/retry and permission changes.

Deploy the API and regenerated clients together. Rollback uses the previous API/console images; this batch has no schema, worker, CI or dependency changes. Do not execute external scanners to validate these read paths.
