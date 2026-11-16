import {
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  projectsControllerUpdateWorkflow,
  useProjectsControllerUpdateWorkflow,
  type ProjectViewDto,
  type UpdateProjectWorkflowDto,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

/** Keep workflow edits and cache writes within their original workspace. */
export function useProjectWorkflowSave(projectId: string, workspaceId: string) {
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const client = useQueryClient();
  const key = getProjectsControllerGetByIdQueryKey(projectId);
  const legacyKey = getAssetGroupControllerGetByIdQueryKey(projectId);
  const update = useProjectsControllerUpdateWorkflow({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: ({ id, bindingId, data }) => {
        if (getGlobalWorkspaceId() !== workspaceId)
          throw new Error('The selected workspace changed');
        return projectsControllerUpdateWorkflow(id, bindingId, data);
      },
    },
  });

  async function save(
    bindingId: string,
    data: UpdateProjectWorkflowDto,
    onSaved: () => void,
  ) {
    if (lock.current || getGlobalWorkspaceId() !== workspaceId) return;
    lock.current = true;
    setSaving(true);
    try {
      const result = await update
        .mutateAsync({ id: projectId, bindingId, data })
        .catch(() => undefined);
      if (!result || getGlobalWorkspaceId() !== workspaceId) return;
      await client.cancelQueries({ queryKey: key, exact: true });
      if (getGlobalWorkspaceId() !== workspaceId) return;
      client.setQueryData<ProjectViewDto>(
        key,
        (project) =>
          project && {
            ...project,
            assetGroupWorkflows: project.assetGroupWorkflows?.map((binding) =>
              binding.id === result.id ? { ...binding, ...result } : binding,
            ),
          },
      );
      await client.invalidateQueries({
        predicate: ({ queryKey: [path] }) =>
          typeof path === 'string' &&
          (path.toLowerCase() === key[0] + '/workflows' || path.toLowerCase() === key[0] ||
            path.toLowerCase() === legacyKey[0]),
        refetchType: getGlobalWorkspaceId() === workspaceId ? 'active' : 'none',
      });
      if (getGlobalWorkspaceId() !== workspaceId) return;
      onSaved();
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  return {
    save,
    saving,
    isLocked: () => lock.current,
    isError: update.isError,
    reset: update.reset,
  };
}
