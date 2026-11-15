# Argus search module

`SearchService` serves existing asset/target pages and a separate top-five finding preview. GET /api/search requires both `asset.read` and `target.read`; finding previews independently require effective `vulnerability.read` (including write and wildcard). Without finding access, the preview is empty. An explicit `severity` filter without that access returns 403 before storage/history reads.

- `FindingSearchService.search` performs one workspace-scoped SQL read of approved records, including fixed, dismissed and archived findings. Exclude pending/rejected proposals and unrecognized severities. Match name, CVE IDs or affected URL with literal case-insensitive text; order by creation time and ID descending and cap at five.
- Only `FindingSearchResultDto` and its safe asset reference leave the finding reader. Do not expose proof, scanner scope, source/conversation metadata or raw entities.
- Finding previews do not participate in legacy target/asset total, pageCount or hasNextPage arithmetic. Keep existing target/asset searches and internal target reads intact.
- Severity-only requests may use an empty value, but do not create blank history records. Other history behavior stays user-owned, independent of result permissions.
- Result responses use `private, no-store`. Console caches include workspace/finding access and suppress stale data during permission refresh, denial and input changes. The shared client retains empty value only for GET /api/search with a severity filter.

Run both search service specs, the finding-search Docker HTTP suite, parser/client/console tests and real desktop/mobile palette/search flows.
