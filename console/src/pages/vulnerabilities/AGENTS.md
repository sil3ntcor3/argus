# Finding console

`ListVulnerabilities` keys its list state by workspace and target. Selection uses
finding IDs, and `FindingBulkActions` scopes its draft to the visible approved
selection and write permissions. Reopen sends dismissal IDs, not finding IDs;
it only removes selected dismissals. Never
turn scanner-fixed findings into active ones in the console.

Use `useFindingWrite` for Reopen and `IssueBoundary` plus the existing issue
dialog for linked issue creation. Retain offline, duplicate-submit, uncertain
outcome and workspace-change protections. Proposal selections keep review
actions separate from remediation actions.

`useFindingWrite` acknowledges saves before refreshing rows. A saved-state
check clears the checked mutation failures even if refreshed rows unmount the
toolbar, but keeps observing workspace changes until that check settles.
