import { ProjectAssetsPage } from '@/pages/projects/project-assets-page';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const assetsSearch = z.object({
  page: z.number().int().min(1).max(10000000).optional().catch(undefined),
});

function ProjectAssetsRoute() {
  const { id } = Route.useParams();
  const { page = 1 } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectAssetsPage
      projectId={id}
      page={page}
      onChange={(next) => void navigate({ search: { page: next } })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/assets')({
  validateSearch: assetsSearch,
  component: ProjectAssetsRoute,
});
