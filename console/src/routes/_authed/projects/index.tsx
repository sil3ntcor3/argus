import { ProjectListPage } from '@/pages/projects/project-list-page';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
  status: z.enum(['active', 'archived', 'all']).optional().catch(undefined),
  page: z.number().int().positive().safe().optional().catch(undefined),
  filter: z.string().trim().optional().catch(undefined),
});

/** Stores paging and the submitted filter in browser history. */
function ProjectListRoute() {
  const { page = 1, filter = '', status = 'active' } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectListPage
      status={status}
      page={page}
      search={filter}
      onChange={({ page, search, status }) => {
        void navigate({
          search: {
            status,
            page: page > 1 ? page : undefined,
            filter: search || undefined,
          },
          replace: true,
        });
      }}
    />
  );
}

export const Route = createFileRoute('/_authed/projects/')({
  validateSearch: (search: Record<string, unknown>) =>
    searchSchema.parse(search),
  component: ProjectListRoute,
});
