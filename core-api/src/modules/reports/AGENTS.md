# Argus reports module

The reports module generates summary and vulnerability PDFs, previews the report data, and stores rendered files in the private `reports` bucket. Report reads use `report.read`; generation and deletion use `report.write`.

- Authorize the workspace record before returning a signed download URL. Generic storage signing does not serve private reports. Keep report object cleanup tied to the record lifecycle.
- Keep preview and PDF data queries consistent. Filters distinguish open findings, scanner fixes, legacy archives, and active or expired dismissals.
- Use the report data service and controller specs. Validate preview and generation against local Docker storage and check output for each report type.

Every finding section, including resolved/dismissed sections, excludes
unapproved proposals. Detection-date filters and ordering use
`findingDetectedAt` so approving an old proposal counts as detection now.

Summary resolved counts/lists include approved scanner fixes and legacy archives,
using `fixedAt` with `updatedAt` as the legacy fallback. Valid dismissal and fix
dates are filtered before merging; deduplicate by finding and use its latest
matching closure date before sorting/limiting. Vulnerability report totals
exclude fixed findings as well as legacy archives.
