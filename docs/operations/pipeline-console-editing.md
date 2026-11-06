# Editing saved pipelines

The Argus group console derives stages from the saved workflow dependencies.
Its summary distinguishes multi-stage pipelines from tools running in parallel.

Changing a configuration or profile preserves the exact authored dependency
graph, job IDs, labels, failure policy, and ordered input preferences. Adding or
removing a tool rebuilds barriers between the remaining populated stages, using
existing job IDs and avoiding collisions with newly added tools. Legacy array
workflows retain their name-based job identities when converted to a map.

Stage and input controls follow separately. This foundation prevents edits
through the existing tool panel from flattening API-authored staged pipelines
or silently resetting their input preferences.

Pipelines containing multiple jobs for one tool are read-only in this tool grid,
which selects tools by ID. Scheduling and running remain available; edits are
blocked at the parent boundary as well as in the controls to protect every job.
