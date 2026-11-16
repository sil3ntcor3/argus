import { projectRouteId } from '@/pages/projects/project-route-id';
import { projectListQueryParam } from '@/pages/projects/project-list-search';
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
  run: projectRouteId.optional().catch(undefined),
  workflow: projectRouteId.optional().catch(undefined),
  query: projectListQueryParam(200),
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
  overdue: z
    .preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean().optional(),
    )
    .catch(undefined),
  discoveredBy: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.split(',') : value),
      z
        .array(z.enum(['tool', 'ai', 'ai_tool', 'manual']))
        .max(4)
        .optional(),
    )
    .catch(undefined),
  createdFrom: z.string().date().optional().catch(undefined),
  createdTo: z.string().date().optional().catch(undefined),
  filter: z.preprocess(value => typeof value === 'string' ? value : JSON.stringify(value), z.string().max(16384).optional()).catch(undefined),
  sortBy: z
    .enum([
      'severity',
      'name',
      'firstDetectedDate',
      'lastSeenDate',
      'firstSeenAt',
      'lastSeenAt',
      'dueAt',
    ])
    .optional()
    .catch(undefined),
  sortOrder: z.enum(['ASC', 'DESC']).optional().catch(undefined),
});

function ProjectFindingsRoute() {
  const { id } = Route.useParams();
  const { page = 1, ...search } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectFindingsPage
      projectId={id}
      page={page}
      {...search}
      onChange={(search) => void navigate({ search })}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/$id/findings')({
  validateSearch: findingsSearch,
  component: ProjectFindingsRoute,
});
