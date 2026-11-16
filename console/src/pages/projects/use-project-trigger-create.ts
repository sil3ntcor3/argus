import {
  type CreateProjectTriggerDto,
  type UpdateProjectTriggerDto,
  projectsControllerUpdateTrigger,
  projectsControllerRemoveTrigger,
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetTriggersQueryKey,
  projectsControllerCreateTrigger,
  useProjectsControllerCreateTrigger,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { isAxiosError } from 'axios';

/** A response can be lost after the trigger and its file definition are saved. */
function uncertain(error: unknown) {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined || status === 408 || status >= 500;
}

/** Keep trigger writes, pending locks and cache refreshes in their workspace. */
export function useProjectTriggerCreate(
  projectId: string,
  bindingId: string,
  workspaceId: string,
  onCreated: () => void,
) {
  const client = useQueryClient();
  const mutationKey = [
    'create-project-trigger',
    workspaceId,
    projectId,
    bindingId,
  ];
  const filter = { mutationKey, exact: true };
  const creating = useIsMutating(filter) > 0;

  /** Mark original views stale without fetching them under another workspace. */
  async function refresh() {
    const paths: string[] = [
      getProjectsControllerGetByIdQueryKey(projectId)[0],
      getProjectsControllerGetTriggersQueryKey(projectId)[0],
      getAssetGroupControllerGetByIdQueryKey(projectId)[0],
    ];
    await client.invalidateQueries({
      predicate: ({ queryKey: [path] }) =>
        typeof path === 'string' && paths.includes(path.toLowerCase()),
      refetchType: getGlobalWorkspaceId() === workspaceId ? 'active' : 'none',
    });
  }
  const create = useProjectsControllerCreateTrigger({
    mutation: {
      mutationKey,
      retry: false,
      networkMode: 'always',
      mutationFn: ({ id, data }) => {
        if (getGlobalWorkspaceId() !== workspaceId)
          throw new Error('The selected workspace changed');
        return projectsControllerCreateTrigger(id, data);
      },
      onSuccess: async () => {
        await refresh();
        if (getGlobalWorkspaceId() !== workspaceId) return;
        onCreated();
      },
      onError: async (error) => {
        if (uncertain(error)) await refresh();
      },
    },
  });
  const unknownOutcome = create.isError && uncertain(create.error);
  const archived =
    isAxiosError<{ message?: string }>(create.error) &&
    create.error.response?.status === 400 &&
    create.error.response.data?.message === 'Project is archived';

  /** Submit once; callers validate their fields and display the mutation outcome. */
  async function save(
    data: Omit<CreateProjectTriggerDto, 'projectWorkflowId'>,
  ) {
    if (
      unknownOutcome ||
      client.isMutating(filter) ||
      getGlobalWorkspaceId() !== workspaceId
    )
      return;
    try {
      await create.mutateAsync({
        id: projectId,
        data: { projectWorkflowId: bindingId, ...data },
      });
    } catch {
      /* Render the mutation outcome beside the caller's input. */
    }
  }
  return {
    save,
    creating,
    unknownOutcome,
    archived,
    isError: create.isError,
    reset: create.reset,
    isLocked: () => client.isMutating(filter) > 0,
  };
}

type ManageWrite = { triggerId: string } & (
  { kind: 'update'; data: UpdateProjectTriggerDto } | { kind: 'remove' }
);

/** Management uses the creation lock too: one pending write per binding. */
export function useProjectTriggerManage(
  projectId: string,
  bindingId: string,
  workspaceId: string,
  onSaved: () => void,
) {
  const client = useQueryClient();
  const mutationKey = [
    'create-project-trigger',
    workspaceId,
    projectId,
    bindingId,
  ];
  const filter = { mutationKey, exact: true };
  const working = useIsMutating(filter) > 0;
  async function refresh() {
    const paths: string[] = [
      getProjectsControllerGetByIdQueryKey(projectId)[0],
      getProjectsControllerGetTriggersQueryKey(projectId)[0],
      getAssetGroupControllerGetByIdQueryKey(projectId)[0],
    ];
    await client.invalidateQueries({
      predicate: ({ queryKey: [path] }) =>
        typeof path === 'string' && paths.includes(path.toLowerCase()),
      refetchType: getGlobalWorkspaceId() === workspaceId ? 'active' : 'none',
    });
  }
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: 'always',
    mutationFn: async (write: ManageWrite) => {
      if (getGlobalWorkspaceId() !== workspaceId)
        throw new Error('The selected workspace changed');
      return write.kind === 'remove'
        ? projectsControllerRemoveTrigger(projectId, write.triggerId)
        : projectsControllerUpdateTrigger(
            projectId,
            write.triggerId,
            write.data,
          );
    },
    onSuccess: async () => {
      await refresh();
      if (getGlobalWorkspaceId() === workspaceId) onSaved();
    },
    onError: async (error) => {
      if (uncertain(error)) await refresh();
    },
  });
  const unknownOutcome = mutation.isError && uncertain(mutation.error);
  async function save(write: ManageWrite) {
    if (
      unknownOutcome ||
      client.isMutating(filter) ||
      getGlobalWorkspaceId() !== workspaceId
    )
      return;
    try {
      await mutation.mutateAsync(write);
    } catch {
      /* The dialog renders the outcome. */
    }
  }
  return {
    save,
    working,
    unknownOutcome,
    isError: mutation.isError,
    reset: mutation.reset,
    isLocked: () => client.isMutating(filter) > 0,
  };
}
