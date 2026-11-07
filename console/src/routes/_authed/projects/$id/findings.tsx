import { ProjectFindingsPage } from '@/pages/projects/project-findings-page';
import { ProjectsControllerGetFindingsProvenance } from '@/services/apis/gen/queries';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const findingsSearch = z.object({
  page: z.number().int().min(1).max(10000000).optional().catch(undefined),
  provenance: z
    .nativeEnum(ProjectsControllerGetFindingsProvenance)
    .optional()
    .catch(undefined),
});

function ProjectFindingsRoute() {
  const { id } = Route.useParams();
  const { page = 1, ...filters } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectFindingsPage
      projectId={id}
      page={page}
      {...filters}
      onChange={(search) => void navigate({ search })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/findings')({
  validateSearch: findingsSearch,
  component: ProjectFindingsRoute,
});
