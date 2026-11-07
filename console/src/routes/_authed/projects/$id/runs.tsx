import { ProjectRunsPage } from '@/pages/projects/project-runs-page';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const runsSearch = z.object({
  page: z.number().int().min(1).max(10000000).optional().catch(undefined),
  trigger: z.enum(['manual', 'scheduled']).optional().catch(undefined),
});

/** Keeps the page and trigger in the URL for direct links and history. */
function ProjectRunsRoute() {
  const { id } = Route.useParams();
  const { page = 1, trigger } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ProjectRunsPage
      projectId={id}
      page={page}
      trigger={trigger}
      onChange={(search) => void navigate({ search })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/runs')({
  validateSearch: runsSearch,
  component: ProjectRunsRoute,
});
