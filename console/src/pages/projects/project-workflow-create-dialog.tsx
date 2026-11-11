import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  isPipelineValid,
  ToolPipelineBuilder,
  type PipelineToolEntry,
} from '@/pages/asset-group/components/tool-pipeline-builder';
import { jobsFromEntries } from '@/pages/asset-group/components/pipeline-mapping';
import {
  getAssetGroupControllerGetByIdQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  getProjectsControllerGetOverviewQueryKey,
  projectsControllerCreateWorkflow,
  useProjectsControllerCreateWorkflow,
  useProjectsControllerGetWorkflowTemplates,
  useProjectsControllerGetMany,
  useProjectsControllerGetById,
  useToolsControllerGetInstalledTools,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { type FormEvent, type KeyboardEvent, useId, useState } from 'react';
import { toast } from 'sonner';
import useDebounce from '@/hooks/use-debounce';
import { projectWorkflowLabel } from './project-workflow-label';

/** Search inputs must not implicitly submit; portaled config forms keep their keys. */
function preventSearchSubmit(event: KeyboardEvent<HTMLElement>) {
  if (
    event.key === 'Enter' &&
    event.target instanceof HTMLInputElement &&
    event.currentTarget.contains(event.target)
  )
    event.preventDefault();
}

/** A transport or upstream error can arrive after the server commits. */
function mayHaveCreated(error: unknown): boolean {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined || status === 408 || status >= 500;
}

/** Create a disabled project workflow from a template or selected tools. */
export function ProjectWorkflowCreateDialog({
  projectId,
  workspaceId,
}: {
  projectId: string;
  workspaceId: string;
}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const mutationKey = ['create-project-workflow', workspaceId, projectId];
  const mutationFilter = { mutationKey, exact: true };
  const creating = useIsMutating(mutationFilter) > 0;
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'template' | 'tools' | 'copy'>(
    'template',
  );
  const [projectSearch, setProjectSearch] = useState('');
  const [sourcePage, setSourcePage] = useState(1);
  const [sourceProject, setSourceProject] = useState('');
  const [copyBinding, setCopyBinding] = useState('');
  const search = useDebounce(projectSearch.trim(), 300);
  const [entries, setEntries] = useState<PipelineToolEntry[]>([]);
  const [template, setTemplate] = useState('');
  const [name, setName] = useState('');
  const templates = useProjectsControllerGetWorkflowTemplates({
    query: {
      enabled: open && source === 'template',
      retry: false,
      networkMode: 'always',
    },
  });
  const tools = useToolsControllerGetInstalledTools(undefined, {
    query: { enabled: open && source === 'tools', retry: false },
  });
  const byId = new Map((tools.data?.data ?? []).map((tool) => [tool.id, tool]));
  const toolsReady = !!tools.data && !tools.isFetching && !tools.isError;
  const projects = useProjectsControllerGetMany(
    { page: sourcePage, limit: 50, search, sortBy: 'id' },
    {
      query: { enabled: open && source === 'copy', retry: false },
    },
  );
  const sourceDetail = useProjectsControllerGetById(sourceProject, {
    query: {
      enabled: open && source === 'copy' && !!sourceProject,
      retry: false,
    },
  });
  const projectsReady =
    !!projects.data &&
    !projects.isError &&
    !projects.isFetching &&
    projectSearch.trim() === search;
  const bindings = (sourceDetail.data?.assetGroupWorkflows ?? []).filter(
    (binding) => binding.workflow,
  );
  const copyReady =
    projectsReady &&
    projects.data?.data.some((project) => project.id === sourceProject) &&
    sourceDetail.data?.id === sourceProject &&
    !sourceDetail.isFetching &&
    !sourceDetail.isError;
  function clearCopySource() {
    setSourceProject('');
    setCopyBinding('');
  }

  /** Refresh project views without refetching under another workspace. */
  async function refreshAssignments() {
    const refetchType =
      workspaceId === getGlobalWorkspaceId() ? 'active' : 'none';
    await Promise.all(
      [
        getProjectsControllerGetByIdQueryKey(projectId),
        getProjectsControllerGetOverviewQueryKey(projectId),
        getAssetGroupControllerGetByIdQueryKey(projectId),
        getProjectsControllerGetManyQueryKey(),
      ].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey, refetchType }),
      ),
    );
  }

  const create = useProjectsControllerCreateWorkflow({
    mutation: {
      mutationKey,
      retry: false,
      networkMode: 'always',
      mutationFn: async ({ id, data }) => {
        if (workspaceId !== getGlobalWorkspaceId())
          throw new Error('The selected workspace changed');
        return projectsControllerCreateWorkflow(id, data);
      },
      onSuccess: async () => {
        if (workspaceId === getGlobalWorkspaceId()) {
          setOpen(false);
          toast.success('Project workflow created.');
        }
        await refreshAssignments();
      },
      onError: async (error) => {
        if (mayHaveCreated(error)) await refreshAssignments();
      },
    },
  });
  const catalog = templates.data ?? [];
  const uncertain = create.isError && mayHaveCreated(create.error);
  const message = isAxiosError<{ message?: unknown }>(create.error)
    ? create.error.response?.data?.message
    : undefined;
  const catalogReady = !templates.isFetching && !templates.isError;
  const canSubmit =
    (source === 'template'
      ? catalogReady && catalog.some((item) => item.filePath === template)
      : source === 'copy'
        ? copyReady && bindings.some((binding) => binding.id === copyBinding)
        : toolsReady &&
          entries.length > 0 &&
          entries.length <= 50 &&
          entries.every((entry) => byId.has(entry.toolId)) &&
          isPipelineValid(entries, byId)) &&
    !uncertain &&
    !creating;

  /** Clear draft data on open and keep the dialog open through submission. */
  function changeOpen(next: boolean) {
    if (queryClient.isMutating(mutationFilter)) return;
    if (next) {
      setSource('template');
      setProjectSearch('');
      setSourcePage(1);
      clearCopySource();
      setEntries([]);
      setTemplate('');
      setName('');
      create.reset();
    }
    setOpen(next);
  }

  /** Submit one scoped request and render failures from the mutation state. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canSubmit ||
      queryClient.isMutating(mutationFilter) ||
      workspaceId !== getGlobalWorkspaceId()
    )
      return;
    const trimmedName = name.trim();
    try {
      await create.mutateAsync({
        id: projectId,
        data: {
          ...(source === 'template'
            ? { template }
            : source === 'copy'
              ? { copyFromProjectWorkflowId: copyBinding }
              : { jobs: jobsFromEntries(entries, byId) }),
          ...(trimmedName ? { name: trimmedName } : {}),
        },
      });
    } catch {
      // The mutation error is shown next to the form.
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          aria-disabled={creating}
          className="aria-disabled:opacity-50"
        >
          {creating ? 'Creating workflow…' : 'Create workflow'}
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={!creating}
        className={
          source === 'tools'
            ? 'sm:max-w-3xl max-h-[90dvh] overflow-y-auto'
            : source === 'copy'
              ? 'max-h-[90dvh] overflow-y-auto'
              : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Create project workflow</DialogTitle>
          <DialogDescription>
            Choose a template, build a tool pipeline, or copy a project
            workflow. Its schedule starts disabled.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor={formId + '-source'}>Creation source</Label>
            <select
              id={formId + '-source'}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-50"
              value={source}
              disabled={creating || uncertain}
              onChange={(event) => {
                setSource(event.target.value as 'template' | 'tools' | 'copy');
                create.reset();
              }}
            >
              <option value="template">Workflow template</option>
              <option value="tools">Selected tools</option>
              <option value="copy">Copy project workflow</option>
            </select>
          </div>
          <div hidden={source !== 'template'} className="space-y-2">
            <Label htmlFor={formId + '-template'}>Workflow template</Label>
            <select
              id={formId + '-template'}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-50"
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              required={source === 'template'}
              disabled={
                source !== 'template' ||
                !catalogReady ||
                !catalog.length ||
                create.isPending ||
                uncertain
              }
            >
              <option value="">Select a template</option>
              {catalog.map((item) => (
                <option key={item.filePath} value={item.filePath}>
                  {item.name}
                </option>
              ))}
            </select>
            {templates.isFetching ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading workflow templates…
              </p>
            ) : templates.isError ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm" role="status">
                  Unable to load workflow templates
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void templates.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : catalog.length === 0 ? (
              <p className="text-sm text-muted-foreground" role="status">
                No default workflow templates are available.
              </p>
            ) : null}
          </div>
          {source === 'tools' && (
            <section
              aria-label="Tool pipeline"
              className="space-y-3"
              onKeyDown={preventSearchSubmit}
            >
              <p className="text-sm text-muted-foreground">
                Select 1–50 tools. Tools in one stage run together; later stages
                wait for the previous stage.
              </p>
              {tools.isError ? (
                <div role="status">
                  <p>Unable to load tools.</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void tools.refetch()}
                  >
                    Retry tools
                  </Button>
                </div>
              ) : !tools.data ? (
                <p role="status">Loading tools…</p>
              ) : null}
              {tools.data && (
                <ToolPipelineBuilder
                  allowInstall
                  tools={tools.data.data}
                  value={entries}
                  onChange={(next) => {
                    setEntries(next);
                    if (create.isError) create.reset();
                  }}
                  disabled={creating || uncertain || !toolsReady}
                />
              )}
            </section>
          )}
          {source === 'copy' && (
            <section
              className="space-y-3"
              aria-label="Copy workflow source"
              onKeyDown={preventSearchSubmit}
            >
              <Label htmlFor={formId + '-search'}>Search projects</Label>
              <Input
                id={formId + '-search'}
                value={projectSearch}
                readOnly={creating || uncertain}
                onChange={(event) => {
                  setProjectSearch(event.target.value);
                  setSourcePage(1);
                  clearCopySource();
                }}
              />
              {projects.isError ? (
                <div role="status">
                  Unable to load projects.{' '}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void projects.refetch()}
                  >
                    Retry projects
                  </Button>
                </div>
              ) : !projectsReady ? (
                <p role="status">Loading projects…</p>
              ) : !projects.data?.data.length ? (
                <p role="status">No projects match this search.</p>
              ) : null}
              <Label htmlFor={formId + '-project'}>Source project</Label>
              <select
                id={formId + '-project'}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-50"
                value={sourceProject}
                disabled={creating || uncertain || !projectsReady}
                onChange={(event) => {
                  setSourceProject(event.target.value);
                  setCopyBinding('');
                }}
              >
                <option value="">Select a project</option>
                {projects.data?.data.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                {(
                  [
                    [-1, 'Previous projects'],
                    [1, 'Next projects'],
                  ] as const
                ).map(([direction, label]) => (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      creating ||
                      uncertain ||
                      !projectsReady ||
                      (direction < 0
                        ? sourcePage <= 1
                        : sourcePage >= (projects.data?.pageCount ?? 1))
                    }
                    onClick={() => {
                      setSourcePage((page) => page + direction);
                      clearCopySource();
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {sourceProject &&
                (sourceDetail.isError ? (
                  <div role="status">
                    Unable to load workflows.{' '}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void sourceDetail.refetch()}
                    >
                      Retry workflows
                    </Button>
                  </div>
                ) : !copyReady ? (
                  <p role="status">Loading workflows…</p>
                ) : !bindings.length ? (
                  <p role="status">This project has no workflows to copy.</p>
                ) : null)}
              <Label htmlFor={formId + '-workflow'}>Source workflow</Label>
              <select
                id={formId + '-workflow'}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-50"
                value={copyBinding}
                disabled={creating || uncertain || !copyReady}
                onChange={(event) => setCopyBinding(event.target.value)}
              >
                <option value="">Select a workflow</option>
                {bindings.map((binding) => (
                  <option key={binding.id} value={binding.id}>
                    {projectWorkflowLabel(binding.workflow)}
                  </option>
                ))}
              </select>
            </section>
          )}
          <div className="space-y-2">
            <Label htmlFor={formId + '-name'}>Workflow name (optional)</Label>
            <Input
              id={formId + '-name'}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                source === 'template'
                  ? 'Use the template name'
                  : source === 'copy'
                    ? 'Use the source workflow name plus (copy)'
                    : 'Project workflow'
              }
              maxLength={120}
              readOnly={creating || uncertain}
            />
          </div>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {uncertain
                ? 'The server may have created the workflow. Close this dialog and check the assignments before trying again.'
                : typeof message === 'string' && message
                  ? message
                  : 'Unable to create the workflow. Check the selected source and try again.'}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              aria-disabled={creating}
              className="aria-disabled:opacity-50"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit && !creating && !uncertain}
              aria-disabled={creating || uncertain}
              className="aria-disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create workflow'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
