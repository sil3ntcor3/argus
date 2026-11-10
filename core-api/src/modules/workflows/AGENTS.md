# Argus workflows module

This module stores workspace workflow definitions, loads default YAML templates, and validates the directed graph executed by jobs-registry. `WorkflowTemplateService` handles defaults. `TriggerWorkflowService` subscribes to target lifecycle events.

- Read and update workspace workflows through `workflow.read` and `workflow.write`. The service normalizes workflow content and validates each step's tool category and inputs. Keep default templates distinct from workspace copies.
- `workflow-graph.ts` handles the canonical job map, legacy arrays, dependencies, order, and advancement. Preserve backward-compatible parsing for stored definitions. Validate before persisting and before starting the affected work.
- Job history and engine transitions belong to jobs-registry. Project assignments and schedules belong to the projects services. When changing a workflow option, verify validation, storage, dispatch, and any copied definitions together.

Run workflow graph, service, template, and trigger tests. Use local Docker integration tests for project assignment and execution.
