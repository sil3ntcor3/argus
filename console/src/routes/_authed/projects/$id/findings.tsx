import { projectFindingSearchTerm } from '@/pages/projects/project-finding-search';
import { ProjectFindingsPage } from '@/pages/projects/project-findings-page';
import {
  ProjectsControllerGetFindingsProvenance,
  ProjectsControllerGetFindingsSeverityItem,
  ProjectsControllerGetFindingsStatus,
} from '@/services/apis/gen/queries';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const findingsSearch = z.object({
  page: z.number().int().min(1).max(10000000).optional().catch(undefined),
  // Direct URL search values can be parsed as primitives by the router.
  query: z
    .preprocess(
      (value) =>
        typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : value,
      projectFindingSearchTerm.optional(),
    )
    .catch(undefined),
  status: z
    .nativeEnum(ProjectsControllerGetFindingsStatus)
    .optional()
    .catch(undefined),
  severity: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.split(',') : value),
      z
        .array(z.nativeEnum(ProjectsControllerGetFindingsSeverityItem))
        .max(5)
        .optional(),
    )
    .catch(undefined),
  provenance: z
    .nativeEnum(ProjectsControllerGetFindingsProvenance)
    .optional()
    .catch(undefined),
});

function ProjectFindingsRoute() {
  const { id } = Route.useParams();
  const { page = 1, query, provenance, severity, status } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectFindingsPage
      projectId={id}
      page={page}
      query={query}
      provenance={provenance}
      severity={severity}
      status={status}
      onChange={(search) => void navigate({ search })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/findings')({
  validateSearch: findingsSearch,
  component: ProjectFindingsRoute,
});
