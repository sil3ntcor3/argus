# Pipeline stages

Group creation accepts an optional `tools[].stage` integer from 1 through 20.
Omitting it places the tool in stage 1, preserving existing parallel execution.

Tools in a stage run in parallel. Every job in a later stage depends on every
job of the nearest earlier populated stage. Gaps in stage numbers are allowed:
stages 1 and 5 behave as two consecutive barriers. Array order does not override
the stage. Saved workflow content and run snapshots contain the resulting
`needs` graph, together with each tool's category, input preferences, encrypted
inline configuration, and profile reference.

When workspace asset discovery is disabled, removed subdomain steps pass their
dependencies to the remaining jobs so that later stages still wait for earlier
enabled work. Removing an initial discovery step still leaves its successors
ready to run against existing assets.

Use the stage selector in a selected tool's panel when creating or editing a
group pipeline. Existing workflows keep their saved graph until a topology
edit; configuration changes preserve their dependencies. No migration or worker
protocol change is required. The current API's unique tool selection policy is
unchanged.
