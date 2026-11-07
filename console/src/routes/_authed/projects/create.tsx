import { ProjectCreatePage } from '@/pages/projects/project-create-page';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/projects/create')({
  component: ProjectCreatePage,
});
