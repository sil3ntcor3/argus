import { ProjectOverviewPage } from '@/pages/projects/project-overview-page';
import { createFileRoute } from '@tanstack/react-router';

/** Supplies the canonical project ID to the overview page. */
function ProjectOverviewRoute() {
  const { id } = Route.useParams();
  return <ProjectOverviewPage projectId={id} />;
}

export const Route = createFileRoute('/_authed/projects/$id/')({
  component: ProjectOverviewRoute,
});
