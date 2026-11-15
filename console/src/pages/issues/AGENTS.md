# Generic issue console

Keep page state keyed by workspace and issue ID. Use issue-api mutations for
all feature writes; generated mutation hooks alone inherit queuing and default
toast behavior. Unknown outcomes block the workspace's issue writes until saved
state is checked and the local draft is explicitly discarded. Never retry a
submitted creation automatically. Authoritative 403/404 hides cached detail.

The global query hash scopes workspace reads. Domain-linked data is permission
filtered by the API. Members still require member.read; do not fetch the member
management endpoint for ordinary issue readers. Asset links use host asset IDs
from the host catalog, not service IDs. Preserve dedicated CommentThread gates.

Finding-list creation supplies approved finding links and a `linkSummary` to
`CreateIssueDialog`. Keep that draft keyed to workspace, permissions and selected
IDs; use the existing `IssueBoundary` and issue mutation safety rules.

Keep the remediation fieldset shrinkable (`min-w-0`); its table scrolls inside
the section. Detail-section heading actions must wrap on narrow screens.
The creation dialog stacks paired fields on narrow screens and scrolls within
the viewport so the remediation type and submit controls stay usable.
