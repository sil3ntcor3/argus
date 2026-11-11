# Internal saved scope reads

The read model loads an owned project and explicitly selects its private automatic
membership preference. Saved rules use deterministic `createdAt`, then ID order.
Rule labels distinguish target and asset IDs even when those tables share a UUID.
Only labels from targets/assets in the requested workspace are resolved; foreign
references retain their stored value and match zero owned assets.

Match counts reuse the bound workspace-scoped compiler. Membership counts recheck
asset ownership and separate manual/rule sources, including rule-source members
whose deleted rule reference is null. Malformed foreign links are ignored without
modifying data. Empty projects return zero counts and the saved preference.

No public route, schema, dependency or membership behavior changes in this batch.
