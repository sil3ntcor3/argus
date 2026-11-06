# Canonical manual membership foundation

The private `ProjectAssetsService.add` validates all requested assets against
the owning workspace and writes under the shared project scope lock. It adds
missing memberships and promotes rule-selected members to manual, clearing the
rule reference so later scope edits retain them. The result contains only IDs
that were newly inserted. Existing manual rows are unchanged, including their
timestamps; promotions do not count as new memberships.

UUID spelling is normalized and duplicate candidates are removed before the
bound-array lookup and upsert. Missing or foreign references reject the whole
transaction. Empty requests still verify project access. Concurrent additions
and scope replacement share the same project lock; transaction failure rolls
back insertions and promotions together.

This foundation adds no public endpoint or event. Canonical API wiring follows
separately. Existing group routes retain their duplicate-error behavior.
