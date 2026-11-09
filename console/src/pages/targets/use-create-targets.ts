import {
  targetsControllerCreateMultipleTargets,
  type CreateMultipleTargetsDto,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useMutation, useQueryClient } from '@tanstack/react-query';

/** Dispatch and invalidate target creation in its originating workspace. */
export function useCreateTargets() {
  const queryClient = useQueryClient();
  return useMutation({
    // A paused request could otherwise resume with a different workspace header.
    networkMode: 'always',
    retry: false,
    mutationFn: ({
      workspaceId,
      data,
    }: {
      workspaceId: string;
      data: CreateMultipleTargetsDto;
    }) => {
      if (workspaceId !== getGlobalWorkspaceId()) {
        throw new Error('The selected workspace changed');
      }
      return targetsControllerCreateMultipleTargets(data);
    },
    onSuccess: ({ totalCreated }, { workspaceId }) => {
      if (totalCreated === 0) return;
      void queryClient.invalidateQueries({
        queryKey: ['targets', workspaceId],
        refetchType: workspaceId === getGlobalWorkspaceId() ? 'active' : 'none',
      });
    },
  });
}
