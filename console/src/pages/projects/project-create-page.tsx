import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  getProjectsControllerGetManyQueryKey,
  projectsControllerCreate,
  useProjectsControllerCreate,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

function CreateProjectForm({ workspaceId }: { workspaceId: string }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const lock = useRef(false);
  const active = useRef(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useProjectsControllerCreate({
    mutation: {
      // Avoid replaying an offline create under a different workspace header.
      networkMode: 'always',
      retry: false,
      mutationFn: async ({ data }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        return projectsControllerCreate(data);
      },
    },
  });

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectName = name.trim();
    if (!projectName || lock.current || workspaceId !== getGlobalWorkspaceId())
      return;

    lock.current = true;
    setCreating(true);
    try {
      const project = await create
        .mutateAsync({
          data: {
            name: projectName,
            description: description.trim() || undefined,
          },
        })
        .catch(() => undefined);
      if (!project || workspaceId !== getGlobalWorkspaceId()) return;
      await queryClient.invalidateQueries({
        queryKey: getProjectsControllerGetManyQueryKey(),
      });
      if (active.current && workspaceId === getGlobalWorkspaceId()) {
        await navigate({ to: '/projects/$id', params: { id: project.id } });
      }
    } finally {
      lock.current = false;
      setCreating(false);
    }
  }

  return (
    <form
      className="max-w-xl space-y-4"
      aria-busy={creating}
      onSubmit={(event) => void submit(event)}
    >
      <div className="space-y-2">
        <Label htmlFor="create-project-name">Project name</Label>
        <Input
          id="create-project-name"
          value={name}
          required
          maxLength={120}
          readOnly={creating}
          className="focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="create-project-description">Description</Label>
        <Textarea
          id="create-project-description"
          value={description}
          maxLength={2000}
          readOnly={creating}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      {create.isError && (
        <p role="alert">Unable to create the project. Try again.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={!name.trim()}
          aria-disabled={creating}
          className="aria-disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create project'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={creating}
          onClick={() => void navigate({ to: '/projects' })}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ProjectCreatePage() {
  const { state } = useWorkspaceState();
  const permission = usePermission();
  const workspaceId = state.selectedWorkspaceId;

  let content: ReactNode;
  if (!workspaceId) content = <p role="status">Select a workspace</p>;
  else if (permission.isLoading)
    content = <p role="status">Loading project access</p>;
  else if (permission.error)
    content = <p role="status">Unable to load project access</p>;
  else if (
    permission.hasPermission('project.write') ||
    permission.hasPermission('group.write')
  )
    content = <CreateProjectForm key={workspaceId} workspaceId={workspaceId} />;
  else content = <AccessDenied />;

  return (
    <Page title="Create project" description="Create a project for your assets">
      {content}
    </Page>
  );
}
