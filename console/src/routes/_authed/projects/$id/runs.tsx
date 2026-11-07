import { ProjectRunsPage } from '@/pages/projects/project-runs-page';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

// Match the API's @IsUUID() validation for workflow binding IDs.
const workflowId = z
  .string()
  .regex(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i,
  )
  .toLowerCase();

const runsSearch = z.object({
  page: z.number().int().min(1).max(10000000).optional().catch(undefined),
  trigger: z.enum(['manual', 'scheduled']).optional().catch(undefined),
  workflow: workflowId.optional().catch(undefined),
  pageSize: z
    .union([z.literal(20), z.literal(50), z.literal(100)])
    .optional()
    .catch(undefined),
});

/** Keeps run filters and pagination in the URL for direct links and history. */
function ProjectRunsRoute() {
  const { id } = Route.useParams();
  const { page = 1, ...filters } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ProjectRunsPage
      projectId={id}
      page={page}
      {...filters}
      onChange={(search) => void navigate({ search })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/runs')({
  validateSearch: runsSearch,
  component: ProjectRunsRoute,
});
