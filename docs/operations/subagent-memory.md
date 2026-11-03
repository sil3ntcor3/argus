# Subagent short-term memory

Subagents can use the existing conversation scratchpad when their definition explicitly declares `stm_write`, `stm_read`, or `stm_list` and the existing tool policy allows them. This ports the tool-wiring fix from upstream #794.

Previously the runner selected tools only from the workspace tool registry, which does not contain memory tools. Declared STM tools were silently omitted. The runner now selects requested STM tools from the memory registry using the parent conversation's workspace, owner, and conversation ID.

## Policy and scope

- Only declared, recognized STM tools are supplied. The default read-only tool set does not gain memory tools automatically.
- Disabled tools remain disabled. The long-term memory setting does not disable the conversation scratchpad.
- Background subagents never receive `ltm_*` tools through this wiring, even when long-term memory is enabled and their definitions request those tools.
- Existing approval filtering remains in place: built-in roles and custom subagents in AUTO mode can receive their declared STM tools. Custom subagents in MANUAL or PLAN mode retain their existing read-only tool set.
- The parent and its children share the conversation scratchpad. A different conversation has separate memory. Existing STM storage, expiration, and conversation ownership checks are unchanged.

This change does not increase concurrency, active-job limits, timeouts, wait budgets, or continuation rounds. It does not change prompts or approval modes.

## Deployment and validation

Deploy the API through the normal rollout. No migration, dependency, new public API contract, generated client, or configuration change is required. Existing definitions that declare STM tools start receiving them when policy allows. API rollback restores the earlier tool selection; stored STM entries keep their existing format and expiration.

From the repository root:

```bash
task api:test:one SPEC=src/modules/agents/agents.subagents.spec.ts
task lint
task test
task console:test:run
task api:build
task console:build
```

For a local Docker rehearsal, use a synthetic model and an AUTO subagent declaring the three STM tools. Have the child write and read a fact, then have the parent read it. Open another conversation and verify that reading the same key returns not found. Inspect the completed child transcript in the console on desktop and mobile. Do not use real scan targets to validate memory wiring.
