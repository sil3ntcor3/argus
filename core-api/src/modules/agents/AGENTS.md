# Argus agents module

AI Studio owns model connections, conversations, streaming replies, approvals, subagents, memories, skills, and user-supplied agent definitions. Routes under `/api/agents` use the selected workspace and `agent.read` or `agent.write`. Preserve conversation ownership checks inside the service as well as the route guard.

- `agents.completions.ts` builds the active model and streams the run. `llm-provider-supported.ts` handles provider-specific options, including the OpenAI Responses path. Model metadata comes from the cached catalog and provider connections.
- `agents.tools.ts` assembles mode-specific tools. Ask and plan tools have different capabilities from execution tools. Keep worker and connector tool gates in sync with the corresponding prompt and approval flow.
- `agents.approvals.ts`, `agents.stop.spec.ts`, and `agents.stream-buffer.ts` cover command and plan approvals, cancellation, and replay. Carry the run's cancellation signal into subagent waits and preserve the identity of each forwarded browser session.
- Remote execution uses the worker pin and assignment rules. Agent configuration, conversations, messages, memories, and user-defined skills have distinct ownership and retention behavior.

Use the provider, mode gating, cancellation, and stream-buffer specs. Local browser smoke can exercise workspace and worker gating without sending prompts to a real provider.
