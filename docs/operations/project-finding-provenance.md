# Project finding provenance

The private query helper uses the latest completed vulnerability scan of the
same asset by the reporting tool in the same project and workspace. Port-only
jobs do not qualify. Runs are ordered by start time and ID. A scan starting at
the same time is not a later scan.

A later eligible scan is `not_seen` only when neither a stored observation nor
a legacy pointer records that finding in the run. If the last reporting run
was removed, the stored sighting time in UTC provides the comparison. Otherwise the
recorded sighting count determines `new` or `recurring`.

The caller supplies owned finding rows as `pv` and `v`. The helper reads only;
the result endpoints follow separately. Validate with
`task api:test:e2e:one SPEC=test/project-finding-provenance.e2e-spec.ts`.
