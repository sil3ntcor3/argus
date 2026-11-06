# Internal project scope SQL

The compiler builds predicates over the `assets` alias `a`. Callers must join
targets and constrain `targets.workspaceId`; the compiler does not authorize
access. Scope APIs and automatic membership are not activated by this foundation.

All rule values use positional bindings. Prefix bindings are copied, hostname
LIKE metacharacters are escaped, and includes are ORed before exclusions are
subtracted. Exclusions alone select nothing. The first matching include supplies
the optional rule ID; projection bindings are allocated once, only when requested.

CIDR rules match raw IPv4/IPv6 asset values or observed host addresses. Argus DNS
observations attach directly to assets; HTTP probe observations can attach through
asset services. DNS resolver addresses are excluded from both paths. Unattributable
observations are omitted. A CASE guards inet casts so hostnames cannot raise a cast
error. No schema, dependencies, routes or existing membership behavior change.
