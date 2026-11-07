import { ProjectWorkflowsPage } from '@/pages/projects/project-workflows-page';
import { createFileRoute } from '@tanstack/react-router';

function ProjectWorkflowsRoute() {
  const { id } = Route.useParams();
  return <ProjectWorkflowsPage projectId={id} />;
}

export const Route = createFileRoute('/_authed/projects/$id/workflows')({
  component: ProjectWorkflowsRoute,
});
