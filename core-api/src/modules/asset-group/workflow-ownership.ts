/** Whether a deletable workflow was generated for this group. */
export function isGroupOwnedWorkflow(
  workflow: { filePath?: string | null; isCanDelete?: boolean } | undefined,
  groupId: string,
): boolean {
  if (!workflow?.filePath || workflow.isCanDelete === false) return false;
  return (
    workflow.filePath === `group-${groupId}.yaml` ||
    // Legacy console-created pipelines used WorkflowsService's name slug.
    workflow.filePath === `group-workflow---${groupId}.yaml` ||
    workflow.filePath.startsWith(`project-${groupId}-`)
  );
}
