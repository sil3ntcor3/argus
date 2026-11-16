import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type CreateProjectDto,
  type ScopeRuleInputDto,
  type ProjectWorkflowOnDto,
  getProjectsControllerGetManyQueryKey,
  projectsControllerCreate,
  useProjectsControllerCreate,
  useProjectsControllerGetWorkflowTemplates,
  useToolsControllerGetInstalledTools,
} from '@/services/apis/gen/queries';
import {
  ToolPipelineBuilder,
  isPipelineValid,
  type PipelineToolEntry,
} from '@/pages/asset-group/components/tool-pipeline-builder';
import { jobsFromEntries } from '@/pages/asset-group/components/pipeline-mapping';
import { ProjectCreateScope } from './project-create-scope';
import {
  ProjectCreateTriggers,
  creationTriggersValid,
} from './project-create-triggers';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
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

/** Keep the full draft local and dispatch one workspace-bound creation request. */
function CreateProjectForm({
  workspaceId,
  canLaunch,
  canReadAssets,
  canReadTools,
}: {
  workspaceId: string;
  canLaunch: boolean;
  canReadAssets: boolean;
  canReadTools: boolean;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [hexColor, setHexColor] = useState('#78716C');
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [scopeRules, setScopeRules] = useState<ScopeRuleInputDto[]>([]);
  const [autoAddAssets, setAutoAddAssets] = useState(true);
  const [source, setSource] = useState<'none' | 'template' | 'tools'>('none');
  const [template, setTemplate] = useState('');
  const [entries, setEntries] = useState<PipelineToolEntry[]>([]);
  const [workflowName, setWorkflowName] = useState('');
  const [on, setOn] = useState<ProjectWorkflowOnDto>({
    schedule: [],
    events: [],
  });
  const [runNow, setRunNow] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const active = useRef(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const templates = useProjectsControllerGetWorkflowTemplates({
    query: { enabled: source === 'template', retry: false },
  });
  const tools = useToolsControllerGetInstalledTools(undefined, {
    query: { enabled: source === 'tools' && canReadTools, retry: false },
  });
  const byId = new Map((tools.data?.data ?? []).map((tool) => [tool.id, tool]));
  const pipelineReady =
    source === 'none' ||
    (source === 'template'
      ? !!templates.data &&
        !templates.isFetching &&
        !templates.isError &&
        templates.data.some((item) => item.filePath === template)
      : canReadTools &&
        !!tools.data &&
        !tools.isFetching &&
        !tools.isError &&
        entries.length > 0 &&
        entries.length <= 50 &&
        entries.every((entry) => byId.has(entry.toolId)) &&
        isPipelineValid(entries, byId));
  const busy = creating || uncertain;
  const valid =
    !!name.trim() &&
    scopeRules.every((rule) => !!rule.value.trim()) &&
    pipelineReady &&
    (source === 'none' || creationTriggersValid(on));
  const create = useProjectsControllerCreate({
    mutation: {
      mutationKey: ['create-project', workspaceId],
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
    if (
      !valid ||
      busy ||
      !projectName ||
      lock.current ||
      workspaceId !== getGlobalWorkspaceId()
    )
      return;

    lock.current = true;
    setCreating(true);
    setError(undefined);
    try {
      const data: CreateProjectDto = {
        name: projectName,
        description: description.trim() || undefined,
        hexColor,
        hostIds: hostIds.length ? hostIds : undefined,
        scopeRules,
        autoAddAssets,
        ...(source !== 'none'
          ? {
              ...(source === 'template'
                ? { template }
                : { jobs: jobsFromEntries(entries, byId) }),
              workflowName: workflowName.trim() || undefined,
              on: {
                schedule: (on.schedule ?? []).map((t) => ({
                  ...t,
                  cron: t.cron.trim().replace(/\s+/g, ' '),
                  enabled: canLaunch && t.enabled === true,
                })),
                events: (on.events ?? []).map((t) => ({
                  ...t,
                  enabled: canLaunch && t.enabled === true,
                })),
              },
              runNow: canLaunch && runNow,
            }
          : {}),
      };
      const project = await create.mutateAsync({
        data,
      });
      if (!project || workspaceId !== getGlobalWorkspaceId()) return;
      await queryClient.invalidateQueries({
        queryKey: getProjectsControllerGetManyQueryKey(),
      });
      if (active.current && workspaceId === getGlobalWorkspaceId()) {
        if (project.creation?.initialRun?.status === 'failed')
          toast.warning(
            'Project saved. The initial run did not start. Open its workflows to try again.',
          );
        if (project.creation?.initialRun?.status === 'empty_scope')
          toast.info('Project saved with no enabled assets to scan yet.');
        if (project.creation?.triggerSync === 'pending')
          toast.warning(
            'Project saved. Trigger synchronization is pending and will retry automatically.',
          );
        await navigate({ to: '/projects/$id', params: { id: project.id } });
      }
    } catch (failure) {
      if (active.current && workspaceId === getGlobalWorkspaceId()) {
        const status = isAxiosError(failure)
          ? failure.response?.status
          : undefined;
        const unknown = status === undefined || status === 408 || status >= 500;
        setUncertain(unknown);
        setError(
          unknown
            ? 'The project may have been created. Check the project list before trying again.'
            : 'Unable to create the project. Check the settings and your access, then try again.',
        );
      }
    } finally {
      lock.current = false;
      setCreating(false);
    }
  }

  return (
    <form
      className="max-w-4xl space-y-4 [overflow-wrap:anywhere]"
      aria-busy={creating}
      onSubmit={(event) => {
        if (event.target === event.currentTarget) void submit(event);
      }}
    >
      <section
        aria-labelledby="create-project-info-heading"
        className="space-y-4 rounded-xl border bg-card p-4"
      >
        <h2 id="create-project-info-heading" className="font-semibold">
          Project details
        </h2>
        <div className="space-y-2">
          <Label htmlFor="create-project-name">Project name</Label>
          <Input
            id="create-project-name"
            value={name}
            required
            maxLength={120}
            readOnly={busy}
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
            readOnly={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <label className="flex w-fit items-center gap-3 text-sm">
          Project color
          <input
            type="color"
            value={hexColor}
            disabled={busy}
            onChange={(e) => setHexColor(e.target.value)}
            className="h-9 w-14 rounded-md border bg-background"
          />
        </label>
      </section>
      <ProjectCreateScope
        workspaceId={workspaceId}
        rules={scopeRules}
        onRulesChange={setScopeRules}
        hostIds={hostIds}
        onHostsChange={setHostIds}
        autoAddAssets={autoAddAssets}
        onAutoAddChange={setAutoAddAssets}
        disabled={busy}
        canReadAssets={canReadAssets}
      />
      <section
        aria-labelledby="create-project-workflow-heading"
        className="space-y-4 rounded-xl border bg-card p-4"
      >
        <h2 id="create-project-workflow-heading" className="font-semibold">
          Initial workflow
        </h2>
        <label className="block space-y-1 text-sm">
          Initial workflow
          <select
            className="h-9 w-full rounded-md border bg-background px-3"
            value={source}
            disabled={busy}
            onChange={(e) => {
              setSource(e.target.value as typeof source);
              setRunNow(false);
            }}
          >
            <option value="none">Add a workflow later</option>
            <option value="template">Workflow template</option>
            {canReadTools && <option value="tools">Selected tools</option>}
          </select>
        </label>
        {source === 'template' && (
          <div className="space-y-2">
            <label className="block space-y-1 text-sm">
              Workflow template
              <select
                className="h-9 w-full rounded-md border bg-background px-3"
                value={template}
                required
                disabled={
                  busy ||
                  !templates.data ||
                  templates.isFetching ||
                  templates.isError
                }
                onChange={(e) => setTemplate(e.target.value)}
              >
                <option value="">Select a template</option>
                {templates.data?.map((item) => (
                  <option key={item.filePath} value={item.filePath}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {templates.isError ? (
              <div role="status">
                Unable to load workflow templates.{' '}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void templates.refetch()}
                >
                  Retry templates
                </Button>
              </div>
            ) : !templates.data || templates.isFetching ? (
              <p role="status">Loading workflow templates…</p>
            ) : !templates.data.length ? (
              <p role="status">No default workflow templates are available.</p>
            ) : null}
          </div>
        )}
        {source === 'tools' && (
          <div
            className="space-y-3"
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                event.target instanceof HTMLInputElement &&
                event.currentTarget.contains(event.target)
              )
                event.preventDefault();
            }}
          >
            <p className="text-sm text-muted-foreground">
              Select 1–50 tools. Tools in a stage run together; later stages
              wait.
            </p>
            {tools.isError ? (
              <div role="status">
                Unable to load tools.{' '}
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
            {tools.data && canReadTools && (
              <ToolPipelineBuilder
                allowInstall
                tools={tools.data.data}
                value={entries}
                onChange={setEntries}
                disabled={busy || tools.isFetching || tools.isError}
              />
            )}
          </div>
        )}
        {source !== 'none' && (
          <label className="block space-y-1 text-sm">
            Workflow name (optional)
            <Input
              value={workflowName}
              readOnly={busy}
              maxLength={120}
              placeholder="Use the default workflow name"
              onChange={(e) => setWorkflowName(e.target.value)}
            />
          </label>
        )}
      </section>
      {source !== 'none' && (
        <ProjectCreateTriggers
          value={on}
          onChange={setOn}
          disabled={busy}
          canLaunch={canLaunch}
        />
      )}
      {source !== 'none' && canLaunch && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={runNow}
            disabled={busy}
            onChange={(e) => setRunNow(e.target.checked)}
          />
          Run after creating
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={!valid || busy}
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
          {uncertain ? 'Check projects' : 'Cancel'}
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
    content = (
      <CreateProjectForm
        key={workspaceId}
        workspaceId={workspaceId}
        canLaunch={permission.hasPermission('workflow.write')}
        canReadAssets={permission.hasPermission('asset.read')}
        canReadTools={permission.hasPermission('tool.read')}
      />
    );
  else content = <AccessDenied />;

  return (
    <Page title="Create project" description="Create a project for your assets">
      {content}
    </Page>
  );
}
