import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectCreatePage } from './project-create-page';

const mock = vi.hoisted(() => ({
  workspace: vi.fn(),
  selectedWorkspace: vi.fn(),
  permission: vi.fn(),
  create: vi.fn(),
  request: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.workspace,
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: mock.selectedWorkspace,
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerCreate: mock.create,
  projectsControllerCreate: mock.request,
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
      data: { name: 'Perimeter', description: 'External services' },
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
});
