# Private project membership provenance

Project membership rows now store `source` (`manual` by default, or `rule`) and
nullable `scopeRuleId`. Existing memberships become manual without changing
their IDs or asset/project references. Removing a rule clears its reference and
retains the membership; deleting a project still cascades its memberships.

The new columns and relation remain private to persistence. Default ORM reads
omit the columns, and entity JSON excludes provenance even when explicitly
loaded or populated by an insert. Legacy membership APIs, response shapes and
permissions remain unchanged. Automatic matching and public scope APIs follow
separately. No uniqueness or existing column nullability changes are included.

Development generates the migration with
`task migration:generate name=AddProjectAssetProvenance`. Review it, back up the
local database and validate `task migration:run` / `task migration:revert` /
reapply before deployment. Rollback drops the new provenance fields and foreign
key, retaining memberships; back up provenance first once rule matching is used.
