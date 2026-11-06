# Project scope value normalization

The internal normalizer prepares upstream scope-rule validation without adding
an API or activating automatic membership. Target/asset UUIDs trim and lowercase;
hostname patterns lowercase and permit `*` wildcards while rejecting empty or
all-wildcard patterns and invalid characters. LIKE escaping treats literal
underscores, percent signs and backslashes safely.

IPv4/IPv6 addresses become /32 or /128 when no prefix is supplied. CIDR prefixes
must be decimal and within the address-family range. Zones, malformed addresses
and extra slash components are rejected. Public DTO length and workspace checks
will accompany scope APIs separately. Bound SQL matching is described in
[project-scope-sql.md](project-scope-sql.md). No schema or dependency changes are needed.
