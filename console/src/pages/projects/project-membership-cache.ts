import {
  getProjectsControllerGetScopeRulesQueryKey,
  getProjectsControllerGetAssetsQueryKey,
  getProjectsControllerGetAssetCandidatesQueryKey,
  getProjectsControllerGetOverviewQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
} from '@/services/apis/gen/queries';
import type { QueryClient } from '@tanstack/react-query';

export async function invalidateProjectMembership(
  queryClient: QueryClient,
  projectId: string,
) {
  const keys = [
    getProjectsControllerGetScopeRulesQueryKey(projectId),
    getProjectsControllerGetAssetsQueryKey(projectId),
    getProjectsControllerGetAssetCandidatesQueryKey(projectId),
    getProjectsControllerGetOverviewQueryKey(projectId),
    getProjectsControllerGetByIdQueryKey(projectId),
    getProjectsControllerGetManyQueryKey(),
  ];
  await Promise.all(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
