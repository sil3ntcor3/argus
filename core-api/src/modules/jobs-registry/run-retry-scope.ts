import { isUUID } from 'class-validator';
import type { JobHistory } from './entities/job-history.entity';

type RunRetryScope =
  | { targetIds: string[] }
  | { projectId: string; projectWorkflowId: string; assetIds: string[] };

/** Only scopes written by the workflow runner can be replayed safely. */
export function getRecordedRunRetryScope({
  scope,
  projectId,
  projectWorkflowId,
}: Pick<
  JobHistory,
  'scope' | 'projectId' | 'projectWorkflowId'
>): RunRetryScope | null {
  if (!scope || Object.keys(scope).length !== 1) return null;

  const projectRun = Boolean(projectId || projectWorkflowId);
  const recordedIds = projectRun ? scope.assetIds : scope.targetIds;
  if (
    !Array.isArray(recordedIds) ||
    recordedIds.length === 0 ||
    !recordedIds.every((id) => isUUID(id))
  ) {
    return null;
  }

  const ids = [...new Set(recordedIds.map((id) => id.toLowerCase()))];
  if (!projectRun) return { targetIds: ids };
  return projectId && projectWorkflowId
    ? { projectId, projectWorkflowId, assetIds: ids }
    : null;
}

export function canRetryRunScope(
  scope: RunRetryScope,
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes('*') ||
    (permissions.includes('job.write') &&
      ('targetIds' in scope || permissions.includes('workflow.write')))
  );
}
