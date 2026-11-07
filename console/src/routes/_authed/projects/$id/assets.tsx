import { projectListQueryParam } from '@/pages/projects/project-list-search';
import { ProjectAssetSource } from '@/services/apis/gen/queries';
import { ProjectAssetsPage } from '@/pages/projects/project-assets-page';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const assetsSearch = z.object({
  page: z.number().int().min(1).max(10000000).optional().catch(undefined),
  pageSize: z
    .union([z.literal(20), z.literal(50), z.literal(100)])
    .optional()
    .catch(undefined),
  source: z.nativeEnum(ProjectAssetSource).optional().catch(undefined),
  query: projectListQueryParam(512),
});

function ProjectAssetsRoute() {
  const { id } = Route.useParams();
  const { page = 1, pageSize, source, query } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectAssetsPage
      projectId={id}
      page={page}
      pageSize={pageSize}
      source={source}
      query={query}
      onChange={(search) => void navigate({ search })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/assets')({
  validateSearch: assetsSearch,
  component: ProjectAssetsRoute,
});
