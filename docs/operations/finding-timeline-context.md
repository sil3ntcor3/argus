# Finding timeline context and scanner sources

Ports timeline/source presentation from Open ASM v0.12.1 (`961d7714`) while
retaining Argus's detail layout, merged extras and scanner safeguards.

`GET /api/vulnerabilities/:id/timeline` still requires effective finding read
access in the selected workspace. It returns at most 500 recognized events,
newest first with an ID tie-breaker, and `Cache-Control: private, no-store`.
Actor references contain only `id`, `name` and `image`; system/deleted actors
are null. The console displays their names or System.

`data` is a typed projection, never the stored JSON object. Context is limited
to the event's recorded comment/note, decision severities, scanner transition
reason, agent reference, merge name/count or linked issue. Text is literal and
bounded: 5,000 characters for notes/comments, 200 for agent names and 300 for
proposal names. Unknown, malformed and irrelevant keys are omitted.

Conversation context additionally requires effective agent read, current
conversation ownership and matching workspace. Issue context requires effective
workspace read and a current issue in that workspace; its number is resolved
from that issue rather than trusted event metadata. Removing those permissions
or deleting the referenced resource suppresses the context on a fresh read.
Existing job-read checks still govern run links.

New review, proposal/verification and merge events save immutable context inside
their existing transactions. No history is backfilled. Old events keep their
recorded type/time and available details, without guessing missing context from
today's finding, reviewer or source. Audit streams do not gain private proof or
decision notes. No schema, worker, scanner policy or dependency change is needed.

Detail source tool references now include nullable `logoUrl`. The console uses
each source's own tool logo/link, keeps a fallback for missing/failed images and
requires effective workspace read for tool-page navigation. Existing evidence,
source-run/conversation controls and compact list source summaries are retained.

Permission refresh hides stale detail/timeline content; the timeline keeps its
loading, empty, denied and retry states. Downgrading the console/API removes
the additive fields and presentation; newly stored context remains valid JSON
and needs no rollback migration.
