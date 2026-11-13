/** Internal cleanup notification, awaited before the project cascade. */
export const PROJECT_DELETING_EVENT = 'project.deleting';
export interface ProjectDeletingEvent { projectId: string; workspaceId: string }
