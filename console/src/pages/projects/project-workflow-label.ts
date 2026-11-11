import type { Workflow } from '@/services/apis/gen/queries';

/** The detail API includes the saved name even though its schema omits it. */
export function projectWorkflowLabel(workflow?: Workflow) {
  const savedName =
    workflow && 'name' in workflow && typeof workflow.name === 'string'
      ? workflow.name.trim()
      : '';
  return savedName || workflow?.content?.name?.trim() || 'Unnamed workflow';
}
