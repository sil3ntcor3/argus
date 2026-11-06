# Editing saved pipelines

The Argus group console derives stages from the saved workflow dependencies.
Its summary distinguishes multi-stage pipelines from tools running in parallel.

Changing a configuration or profile preserves the exact authored dependency
graph, job IDs, labels, failure policy, and ordered input preferences. Adding or
removing a tool rebuilds barriers between the remaining populated stages, using
existing job IDs and avoiding collisions with newly added tools. Legacy array
workflows retain their name-based job identities when converted to a map.

Each selected tool has a stage caption and a labelled selector for stages 1–20.
Tools in one stage run together; later populated stages wait for the previous
stage. All installed categories, including HTTP probes and screenshots, are
available in create and edit flows. Configuration readiness checks still apply.

Stage numbers show relative dependency layers: saving compresses empty stage
numbers. Use **Input preference** to follow catalog defaults or require one
accepted kind; saved custom orders remain intact. See
[pipeline inputs and outputs](pipeline-tool-inputs.md) for the selection rules.

Pipelines containing multiple jobs for one tool are read-only in this tool grid,
which selects tools by ID. Scheduling and running remain available; edits are
blocked at the parent boundary as well as in the controls to protect every job.
