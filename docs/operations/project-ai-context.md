# Project AI context (Open ASM v0.12.1 port)

This batch ports the project AI/files feature introduced by upstream #834,
bounded by release `v0.12.1` (`961d77142671e90190bd97132638441e593bec47`).
It uses Argus's canonical Projects, workflow, trigger and immutable artifact
publication services. Existing Files, Responses, AI Pentest, chat resizing,
history anchoring and project-trigger features remain available.

## Project context and files

Project Overview and Settings contain an AI context card. Project writers can
save instructions of up to 2,000 characters and attach up to five Markdown,
text or CSV files, each from 1 byte through 10 MiB. Project readers can view the
context and use it in chats when they also have agent access. A fresh metadata
read detects another member's instruction edit before saving a local draft.
That comparison is a client safeguard, not an atomic cross-client edit token.

The file endpoints are under `/api/projects/:id/files`: list, `presign`,
`:artifactId/complete`, and detach by `:artifactId`. Writes require
`project.write`; reads require effective `project.read`. Upload completion
requires the caller's own same-workspace upload. Archived projects reject
writes. Attachment capacity is checked again under the project lock after
immutable file publication. If the final slot was taken, the published file
remains in workspace Files, charged once against storage usage.

Detaching a file removes its project association. It retains the artifact,
content, owner sharing choices and quota charge. Ordinary file deletion also
removes associations through the artifact foreign key. Reference files become
shared project context: project readers can read their text through the agent
even when the underlying workspace file is private to its uploader.

Each turn loads the recorded project's current instructions and reference
files. Prompt text is capped at 8,000 characters per file and 30,000 combined.
Actual object reads are bounded at 10 MiB. `read_project_file` returns at most
20,000 characters per call and provides the next offset. Unavailable files are
omitted from the prompt; their failure does not widen the project scope.

## Conversations, tools and cancellation

The new-chat project picker and project links record the project on the
conversation. Later sends retain that recorded scope. Project-aware tools
prefer the conversation's project over model-supplied IDs; exact asset-service
and finding lookups verify project membership. Project tool permissions are
checked at execution, including after approval. Domain read permissions still
apply to assets, findings, jobs and targets. Workflow launches additionally
require `workflow.write`.

Read tools cover projects, project assets/runs/files, workflow templates and
pipeline tools. Agent-mode writes cover project creation, target/scope changes,
workflow and trigger changes, tool installation, instructions, member assets
and workflow launches. They use Argus's existing write-tool approval gates.
API-key-only MCP sessions retain their existing tools; the added project tools
require an authenticated member identity so they can check current permissions.

`create_project` atomically creates a basic project and links an owned,
previously unscoped conversation before configuring its targets and pipeline.
Parallel or repeated calls cannot reassign that conversation. A failed or
stopped later setup can leave a linked project and completed setup steps for
inspection and recovery. Stop prevents subsequent steps; already committed
atomic writes are retained. Scope additions/removals merge under the same
project lock as ordinary scope replacement.

Project deletion stops local active streams and forgets cached conversation
context before FK cascade. An active agent/project stream also polls durable
conversation and permission state every two seconds, so a deletion on another
API replica is detected. This is polling, not instantaneous cross-replica
cancellation. New scoped conversations serialize with project deletion.

## Reasoning and workers

Model connections and agent defaults support nullable reasoning effort.
Release values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.
The picker uses model-supported levels, with low/medium/high as the fallback.
An unset effective choice uses the provider default. Existing per-model and
subagent overrides retain precedence. Argus's OpenAI Responses support and
`store: false` behavior are preserved.

The mode toggle and worker picker are separate. Agent-mode submission still
checks for an available worker. A delayed worker connection cannot resume a
send after the requested project or workspace changes. Pending reasoning and
default saves block submission, and offline mutations are not queued for replay
in another workspace. Project-context writes retain pending/uncertain state
across remounts; refresh the saved state before retrying an uncertain outcome.

## Deployment and rollback

The approved, generated `AddProjectChatContext` migration adds nullable project
instructions, conversation project linkage, connection/default effort and the
project/file association table. It has no content or attribution backfill.
Old unscoped chats and stored file contents remain unchanged. Conversation
linkage uses `ON DELETE CASCADE`; deleting a project deletes its linked chats.

Back up the database and retain encryption keys before deployment. Apply the
migration through the existing local/release migration task. To roll back,
stop project agent activity and deploy the previous application before reverting
the migration. Reverting drops the new context, associations and effort fields;
it does not delete workspace artifact objects. Preserve a database backup if
that metadata needs to survive rollback.

Validation commands, from the repository root with local Docker dependencies:

```sh
task lint
task api:test
task console:test:run
task api:build
task console:build
task api:test:e2e:one SPEC=test/project-ai-files.e2e-spec.ts
```

Use an isolated local test database for the e2e spec. It tests real presigned
S3 POSTs and immutable publication, ownership/tenant/archive denial, quota
preservation, concurrent capacity, scope patching and once-only chat linkage,
service-ID authorization, and concurrent partial reasoning saves. Desktop and
mobile browser validation uses a local compatible model fixture, with no paid
provider calls.
