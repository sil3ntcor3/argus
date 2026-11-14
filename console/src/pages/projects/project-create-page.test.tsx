import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectCreatePage } from './project-create-page';

const mock = vi.hoisted(() => ({
  workspace: vi.fn(),
  selectedWorkspace: vi.fn(),
  permission: vi.fn(),
  create: vi.fn(),
  request: vi.fn(),
  navigate: vi.fn(),
  templates: vi.fn(),
  assets: vi.fn(),
  preview: vi.fn(),
  tools: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.workspace,
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: mock.selectedWorkspace,
}));
vi.mock('sonner', () => ({
  toast: { warning: mock.warning, success: vi.fn(), error: vi.fn() },
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerCreate: mock.create,
  projectsControllerCreate: mock.request,
  useProjectsControllerGetWorkflowTemplates: mock.templates,
  useAssetsControllerGetHostAssets: mock.assets,
  useProjectsControllerPreviewScope: mock.preview,
  useToolsControllerGetInstalledTools: mock.tools,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mock.navigate,
  Link: ({ children, to }: { children: string; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectCreatePage />
    </QueryClientProvider>,
  );
}

describe('ProjectCreatePage', () => {
  beforeAll(()=>vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} }));
  afterAll(()=>vi.unstubAllGlobals());
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workspace.mockReturnValue({ state: { selectedWorkspaceId: 'one' } });
    mock.selectedWorkspace.mockReturnValue('one');
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'group.write',
    });
    mock.create.mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue({ id: projectId }),
    });
    mock.templates.mockReturnValue({
      data: [{ filePath: 'scan.yaml', name: 'Argus scan' }],
      refetch: vi.fn(),
    });
    mock.assets.mockReturnValue({
      data: { data: [], pageCount: 1 },
      refetch: vi.fn(),
    });
    mock.preview.mockReturnValue({
      mutateAsync: vi
        .fn()
        .mockResolvedValue({ total: 2, ruleAssets: 2, perRule: [2] }),
      reset: vi.fn(),
    });
    mock.tools.mockReturnValue({ data: { data: [] }, refetch: vi.fn() });
  });

  it('gates the form and mutation when the workspace lacks a write grant', () => {
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    show();
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('requires a name, trims the draft and opens the new project on success', async () => {
    show();
    const submit = screen.getByRole('button', { name: 'Create project' });
    const name = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(name, { target: { value: '  ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(name, { target: { value: '  Perimeter  ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: '  External services  ' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mock.navigate).toHaveBeenCalledExactlyOnceWith({
        to: '/projects/$id',
        params: { id: projectId },
      }),
    );
    expect(
      mock.create.mock.results[0].value.mutateAsync,
    ).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        name: 'Perimeter',
        description: 'External services',
        scopeRules: [],
        autoAddAssets: true,
      }),
    });
  });

  it('does not queue offline writes or dispatch a delayed request into another workspace', async () => {
    show();
    const options = mock.create.mock.lastCall?.[0]?.mutation;
    expect(options?.networkMode).toBe('always');
    expect(options?.retry).toBe(false);
    mock.selectedWorkspace.mockReturnValue('two');
    await expect(
      options?.mutationFn({ data: { name: 'Perimeter' } }),
    ).rejects.toThrow('The selected workspace changed');
    expect(mock.request).not.toHaveBeenCalled();
  });

  it('checks that the form still belongs to the active workspace before writing', () => {
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Perimeter' },
    });
    mock.selectedWorkspace.mockReturnValue('two');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(
      mock.create.mock.results[0].value.mutateAsync,
    ).not.toHaveBeenCalled();
    expect(mock.navigate).not.toHaveBeenCalled();
  });

  it('composes scope, a template and an explicitly disabled schedule in one request', async () => {
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Perimeter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add scope rule' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rule value 1' }), {
      target: { value: '*.example.test' },
    });
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Initial workflow' }),
      { target: { value: 'template' } },
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Workflow template' }),
      { target: { value: 'scan.yaml' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }));
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Cron expression 1 (UTC)' }),
      { target: { value: '0 8 * * *' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(mock.navigate).toHaveBeenCalled());
    expect(mock.create.mock.results[0].value.mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopeRules: [
          { mode: 'include', type: 'hostname', value: '*.example.test' },
        ],
        template: 'scan.yaml',
        on: { schedule: [{ cron: '0 8 * * *', enabled: false }], events: [] },
        runNow: false,
      }),
    });
    expect(
      screen.queryByRole('checkbox', { name: 'Run after creating' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Enable schedule 1' }),
    ).not.toBeInTheDocument();
  });

  it('blocks duplicate submits and editing while a creation request is pending', async () => {
    let complete: (v: { id: string }) => void = () => {};
    mock.create.mockReturnValue({
      mutateAsync: vi.fn(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      ),
    });
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Once' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Creating…' }));
    expect(mock.create.mock.results[0].value.mutateAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(
      screen.getByRole('textbox', { name: 'Project name' }),
    ).toHaveAttribute('readonly');
    complete({ id: projectId });
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledTimes(1));
  });

  it('requires checking existing projects after an uncertain transport outcome', async () => {
    mock.create.mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(new Error('Connection reset')),
    });
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Uncertain' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /may have been created/,
      ),
    );
    expect(
      screen.getByRole('button', { name: 'Create project' }),
    ).toBeDisabled();
    expect(mock.navigate).not.toHaveBeenCalled();
  });
  it('includes selected owned host IDs and invalidates a scope estimate after editing', async () => {
    mock.permission.mockReturnValue({hasPermission:(key:string)=>['project.write','asset.read'].includes(key)});
    mock.assets.mockReturnValue({data:{data:[{id:projectId,host:'manual.example.test'}],pageCount:1}});
    show();
    fireEvent.change(screen.getByRole('textbox',{name:'Project name'}),{target:{value:'Scoped'}});
    fireEvent.click(screen.getByRole('checkbox',{name:'manual.example.test'}));
    fireEvent.click(screen.getByRole('button',{name:'Add scope rule'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Rule value 1'}),{target:{value:'*.example.test'}});
    fireEvent.click(screen.getByRole('button',{name:'Preview rule matches'}));
    await waitFor(()=>expect(screen.getByText(/2 assets match these rules/)).toBeVisible());
    fireEvent.change(screen.getByRole('textbox',{name:'Rule value 1'}),{target:{value:'other.example.test'}});
    expect(screen.queryByText(/2 assets match these rules/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Create project'}));
    await waitFor(()=>expect(mock.navigate).toHaveBeenCalled());
    expect(mock.create.mock.results[0].value.mutateAsync).toHaveBeenCalledWith({data:expect.objectContaining({hostIds:[projectId],scopeRules:[{mode:'include',type:'hostname',value:'other.example.test'}]})});
  });

  it('validates event numbers and supports launch choices only with launch access',async()=>{
    mock.permission.mockReturnValue({hasPermission:()=>true});
    show();
    fireEvent.change(screen.getByRole('textbox',{name:'Project name'}),{target:{value:'Events'}});
    fireEvent.change(screen.getByRole('combobox',{name:'Initial workflow'}),{target:{value:'template'}});
    fireEvent.change(screen.getByRole('combobox',{name:'Workflow template'}),{target:{value:'scan.yaml'}});
    fireEvent.click(screen.getByRole('button',{name:'Add when assets are added'}));
    fireEvent.change(screen.getByRole('spinbutton',{name:'Gather for (minutes)'}),{target:{value:''}});
    expect(screen.getByRole('button',{name:'Create project'})).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton',{name:'Gather for (minutes)'}),{target:{value:'0'}});
    fireEvent.click(screen.getByRole('checkbox',{name:'Enable when assets are added'}));
    fireEvent.click(screen.getByRole('checkbox',{name:'Run after creating'}));
    fireEvent.click(screen.getByRole('button',{name:'Create project'}));
    await waitFor(()=>expect(mock.navigate).toHaveBeenCalled());
    expect(mock.create.mock.results[0].value.mutateAsync).toHaveBeenCalledWith({data:expect.objectContaining({runNow:true,on:{schedule:[],events:[{event:'project.assets.added',enabled:true,windowMinutes:0,maxAssets:200}]}})});
  });

  it('opens the saved project and explains postcommit recovery without repeating create', async () => {
    mock.create.mockReturnValue({
      mutateAsync: vi
        .fn()
        .mockResolvedValue({
          id: projectId,
          creation: {
            initialRun: { status: 'failed' },
            triggerSync: 'pending',
          },
        }),
    });
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Saved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledTimes(1));
    expect(mock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/saved.*run.*not.*start/i),
    );
    expect(mock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/synchronization.*pending/i),
    );
    expect(mock.create.mock.results[0].value.mutateAsync).toHaveBeenCalledTimes(
      1,
    );
  });
});
