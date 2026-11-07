import { ProjectSettingsPage } from '@/pages/projects/project-settings-page';
import { createFileRoute } from '@tanstack/react-router';

function ProjectSettingsRoute() {
  const { id } = Route.useParams();
  return <ProjectSettingsPage projectId={id} />;
}

export const Route = createFileRoute('/_authed/projects/$id/settings')({
  component: ProjectSettingsRoute,
});
