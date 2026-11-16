import type { ProjectTriggerDto } from './dto/project-trigger-read.dto';
import { PROJECT_TRIGGER_EVENTS } from './dto/project-trigger-read.dto';

export interface ProjectRunContext {
  triggerType: ProjectTriggerDto['type'] | null;
  triggerEvent: ProjectTriggerDto['event'];
  causedByRunId: string | null;
  causedByWorkflowName: string | null;
}

/** Join provenance only after the selected run's project and workflow are scoped. */
export const projectRunContextJoin = (run: string, binding: string) => `
  LEFT JOIN project_workflow_triggers context_trigger ON context_trigger.id=${run}."triggerId"
    AND context_trigger."projectWorkflowId"=${binding}.id
  LEFT JOIN job_histories context_cause ON context_cause.id=${run}."causedByRunId"
    AND context_cause.id<>${run}.id
  LEFT JOIN workflows context_workflow ON context_workflow.id=context_cause."workflowId"
    AND context_workflow."workspaceId"=$2
  LEFT JOIN projects context_project ON context_project.id=context_cause."projectId"
    AND context_project."workspaceId"=$2
  LEFT JOIN project_workflows context_binding ON context_binding.id=context_cause."projectWorkflowId"
    AND context_binding."projectId"=context_cause."projectId"
    AND context_binding."workflowId"=context_cause."workflowId"`;

export const PROJECT_TRIGGER_EVENT_SELECT = `
  CASE WHEN context_trigger.type='event' AND context_trigger.event IN (${PROJECT_TRIGGER_EVENTS.map(e => "'" + e + "'").join(',')})
    THEN context_trigger.event END AS "triggerEvent"`;

export const PROJECT_RUN_CONTEXT_SELECT = `
  CASE WHEN context_trigger.type IN ('cron','event') THEN context_trigger.type END AS "triggerType",
  ${PROJECT_TRIGGER_EVENT_SELECT},
  CASE WHEN context_workflow.id IS NOT NULL AND (context_cause."projectId" IS NULL OR context_project.id IS NOT NULL)
    AND (context_cause."projectWorkflowId" IS NULL OR context_binding.id IS NOT NULL)
    THEN context_cause.id END AS "causedByRunId",
  CASE WHEN context_workflow.id IS NOT NULL AND (context_cause."projectId" IS NULL OR context_project.id IS NOT NULL)
    AND (context_cause."projectWorkflowId" IS NULL OR context_binding.id IS NOT NULL)
    THEN context_workflow.name END AS "causedByWorkflowName"`;
