import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  type ProjectViewDto,
  projectsControllerGetById,
  projectsControllerUpdate,
  type UpdateProjectDto,
  useProjectsControllerGetById,
  useProjectsControllerUpdate,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ProjectDeleteDialog } from './project-delete-dialog';
import { projectRouteId } from './project-route-id';

type Draft = {
  saved: Pick<ProjectViewDto, 'name' | 'description'>;
  name?: string;
  description?: string;
};

class SettingsChanged extends Error {}

function SettingsForm({
  project,
  workspaceId,
}: {
  project: ProjectViewDto;
  workspaceId: string;
}) {
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const key = getProjectsControllerGetByIdQueryKey(project.id);
  const saved = draft?.saved ?? project;
  const name = draft?.name ?? saved.name;
  const description = draft?.description ?? saved.description ?? '';
  const patch: UpdateProjectDto = {};
  if (draft?.name !== undefined && name.trim() !== saved.name)
    patch.name = name.trim();
  const normalizedDescription = description.trim() || null;
  if (
    draft?.description !== undefined &&
    normalizedDescription !== saved.description
  )
    patch.description = normalizedDescription;

  const update = useProjectsControllerUpdate({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: async ({ id, data }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        const current = await projectsControllerGetById(id, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        if (
          (data.name !== undefined && current.name !== saved.name) ||
          (data.description !== undefined &&
            current.description !== saved.description)
        ) {
          await storeSaved(current);
          throw new SettingsChanged();
        }
        return projectsControllerUpdate(id, data);
      },
    },
  });
  const stale = update.error instanceof SettingsChanged;
  const canSave =
    !stale &&
    patch.name !== '' &&
    (patch.name !== undefined || patch.description !== undefined);

  async function storeSaved(current: ProjectViewDto) {
    if (workspaceId !== getGlobalWorkspaceId()) return false;
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    if (workspaceId !== getGlobalWorkspaceId()) return false;
    queryClient.setQueryData(key, current);
    return true;
  }

  function edit(field: 'name' | 'description', value: string) {
    setDraft((current) => ({
      ...(current ?? { saved: project }),
      [field]: value,
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || lock.current || workspaceId !== getGlobalWorkspaceId())
      return;
    lock.current = true;
    setSaving(true);
    try {
      const result = await update
        .mutateAsync({ id: project.id, data: patch })
        .catch(() => undefined);
      if (!result || !(await storeSaved(result))) return;
      setDraft(undefined);
      await queryClient.invalidateQueries({
        queryKey: getProjectsControllerGetManyQueryKey(),
      });
      if (workspaceId === getGlobalWorkspaceId())
        toast.success('Project settings saved.');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  const form = (
    <form
      className="space-y-4"
      aria-busy={saving}
      onSubmit={(event) => void submit(event)}
    >
      <div className="space-y-2">
        <Label htmlFor="project-settings-name">Project name</Label>
        <Input
          ref={nameInput}
          id="project-settings-name"
          value={name}
          required={draft?.name !== undefined}
          maxLength={120}
          readOnly={saving}
          className="focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => edit('name', event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="project-settings-description">Description</Label>
        <Textarea
          id="project-settings-description"
          value={description}
          maxLength={2000}
          readOnly={saving}
          onChange={(event) => edit('description', event.target.value)}
        />
      </div>
      {update.isError && (
        <p role="alert">
          {stale
            ? 'Project settings changed. Load the saved values before trying again.'
            : 'Unable to save project settings. Try again.'}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={!canSave}
          aria-disabled={saving}
          className="aria-disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {stale && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              nameInput.current?.focus();
              setDraft(undefined);
              update.reset();
            }}
          >
            Load saved values
          </Button>
        )}
      </div>
    </form>
  );

  return (
    <div className="max-w-xl space-y-6">
      {form}
      <section
        className="space-y-2 border-t pt-4"
        aria-label="Project deletion"
      >
        <h2 className="font-semibold">Delete this project</h2>
        <ProjectDeleteDialog
          projectId={project.id}
          projectName={project.name}
          workspaceId={workspaceId}
          disabled={saving}
        />
      </section>
    </div>
  );
}

function WorkspaceProjectSettings({
  projectId,
  workspaceId,
}: {
  projectId: string;
  workspaceId: string;
}) {
  const project = useProjectsControllerGetById(projectId, {
    query: { retry: false },
  });
  const status = isAxiosError(project.error)
    ? project.error.response?.status
    : undefined;
  if (status === 401 || status === 403) return <AccessDenied />;
  if (status === 404) return <p role="status">Project not found</p>;
  if (project.isError && !project.data)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load project settings</p>
        <Button variant="outline" onClick={() => void project.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (!project.data) return <p role="status">Loading project settings</p>;
  return <SettingsForm project={project.data} workspaceId={workspaceId} />;
}

export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const { state } = useWorkspaceState();
  const permission = usePermission();
  const workspaceId = state.selectedWorkspaceId;
  const parsedId = projectRouteId.safeParse(projectId);

  let content: ReactNode;
  if (!workspaceId) content = <p role="status">Select a workspace</p>;
  else if (permission.isLoading)
    content = <p role="status">Loading project access</p>;
  else if (permission.error)
    content = <p role="status">Unable to load project access</p>;
  else if (
    !permission.hasPermission('project.write') &&
    !permission.hasPermission('group.write')
  )
    content = <AccessDenied />;
  else if (!parsedId.success) content = <p role="status">Project not found</p>;
  else
    content = (
      <div className="space-y-4">
        <Link
          to="/projects/$id"
          params={{ id: parsedId.data }}
          className="text-sm text-primary hover:underline"
        >
          Back to project overview
        </Link>
        <WorkspaceProjectSettings
          key={`${workspaceId}:${parsedId.data}`}
          projectId={parsedId.data}
          workspaceId={workspaceId}
        />
      </div>
    );

  return <Page title="Project settings">{content}</Page>;
}
