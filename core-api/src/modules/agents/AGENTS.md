# Argus agents module

AI Studio owns model connections, conversations, streaming replies, approvals, subagents, memories, skills, and user-supplied agent definitions. Routes under `/api/agents` use the selected workspace and `agent.read` or `agent.write`. Preserve conversation ownership checks inside the service as well as the route guard.

- `agents.completions.ts` builds the active model and streams the run. `llm-provider-supported.ts` handles provider-specific options, including the OpenAI Responses path. Model metadata comes from the cached catalog and provider connections.
- `save_file` is a conversation-only write tool. The common completion tool set gates it through approvals before checking current workspace membership and `artifact.write`. It saves private UTF-8 files through `ArtifactBufferService`, defaults MIME to text/plain, caps actual bytes at 50 MiB, and forwards Stop. Its result contains file identity, display name, bytes, and a message.
- `agents.tools.ts` assembles mode-specific tools. Ask and plan tools have different capabilities from execution tools. Keep worker and connector tool gates in sync with the corresponding prompt and approval flow.
- `agents.approvals.ts`, `agents.stop.spec.ts`, and `agents.stream-buffer.ts` cover command and plan approvals, cancellation, and replay. Carry the run's cancellation signal into subagent waits and preserve the identity of each forwarded browser session.
- Remote execution uses the worker pin and assignment rules. Agent configuration, conversations, messages, memories, and user-defined skills have distinct ownership and retention behavior.

Use the provider, mode gating, cancellation, and stream-buffer specs. Local browser smoke can exercise workspace and worker gating without sending prompts to a real provider.

`propose_vulnerability` is an AGENT-mode, conversation-only write tool behind
existing plan/todo/approval gates. Pass trusted user/chat/project scope and Stop
to `VulnerabilityProposalService`; model arguments cannot set ownership or approve
a finding. Subagents pass their actual name for attribution. Only pentest,
exploit-verifier and retester built-ins include the release's proposal tool.

Generic issue read tools pass the current actor for fresh workspace/domain checks.
Only the authenticated workspace-key MCP entry point sets workspaceApiKey;
missing conversation actor context must not fall back to privileged reads.

`discover_vulnerabilities` uses open-by-default lifecycle/review filters and
severity ordering. Recheck current vulnerability access; linked issue context
also needs effective workspace read access. MCP workspace-key reads use only the
explicit trusted scope. Return bounded finding context, never raw source/actor
data. Workspace date filters use first detection with legacy fallback and UTC
end-of-day; project calls use only q/status/severity and retain the project lock.
