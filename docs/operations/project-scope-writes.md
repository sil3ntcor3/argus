# Atomic project scope replacement

The internal `ProjectScopeWriteService.replaceRules` prepares scope writes for a
later API batch. It accepts at most 100 rules, each with a string value up to 255
characters, and an optional strict boolean automatic-membership preference.

Replacement locks the owned project row and validates references through the
same transaction manager. It replaces the rules, optionally updates the preference
and reconciles rule membership before committing. Normalization deduplicates
canonical rules. Stored creation/ID order determines first-match provenance;
input order is not promised. Omitting the preference preserves its saved value.
Empty rules remove rule-source members while retaining manual members.

An error rolls back rules, preference, membership and provenance together.
Concurrent replacements use the shared project lock. No controller, discovery
hook or legacy mutation invokes this service yet; coordinated manual membership
and public scope writes follow separately.

Run `task api:test:e2e:one SPEC=test/project-scope-write.e2e-spec.ts` against the
disposable local Docker database. Reverting this preparation removes the unused
provider and optional normalizer manager argument without changing stored data.
