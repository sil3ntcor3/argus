import { projectRouteId } from '@/pages/projects/project-route-id';
import { ProjectRunsPage } from '@/pages/projects/project-runs-page';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const runsSearch = z.object({
  page: z.number().int().min(1).max(10000000).optional().catch(undefined),
  trigger: z.enum(['manual', 'scheduled', 'event']).optional().catch(undefined),
  workflow: projectRouteId.optional().catch(undefined),
  pageSize: z
    .union([z.literal(20), z.literal(50), z.literal(100)])
    .optional()
    .catch(undefined),
});

/** Keeps run filters and pagination in the URL for direct links and history. */
function ProjectRunsRoute() {
  const { id } = Route.useParams();
  const { page = 1, trigger, workflow, pageSize } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ProjectRunsPage
      projectId={id}
      page={page}
      trigger={trigger}
      workflow={workflow}
      pageSize={pageSize}
      onChange={(search) => void navigate({ search })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/runs')({
  validateSearch: runsSearch,
  component: ProjectRunsRoute,
});
