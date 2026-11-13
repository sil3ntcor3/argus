import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSettingsPage } from './project-settings-page';
vi.mock('./project-agent-context', () => ({ ProjectAgentContext: () => <div>Project AI context</div> }));

const mock = vi.hoisted(() => ({
  permission: vi.fn(),
  query: vi.fn(),
  fresh: vi.fn(),
  patch: vi.fn(),
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'fixture' } }),
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: () => 'fixture',
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetById: mock.query,
  projectsControllerGetById: mock.fresh,
  projectsControllerUpdate: mock.patch,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: string }) => <a>{children}</a>,
}));

const id = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const project = { id, name: 'Perimeter', description: 'Outside services' };

function show(projectId = id) {
  const client = new QueryClient();
  return render(<ProjectSettingsPage projectId={projectId} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe('ProjectSettingsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'group.write',
    });
    mock.query.mockReturnValue({ data: project });
    mock.fresh.mockResolvedValue(project);
    mock.patch.mockResolvedValue({ ...project, description: null });
  });

  it('requires project write permission before reading settings', () => {
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    show();
    expect(mock.query).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
  });

  it('patches just the changed field and clears a blank description', async () => {
    mock.fresh.mockResolvedValue({ ...project, name: 'Renamed elsewhere' });
    show(id.toUpperCase());
    expect(mock.query).toHaveBeenCalledWith(id, expect.anything());
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: '   ' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(mock.patch).toHaveBeenCalledExactlyOnceWith(id, {
        description: null,
      }),
    );
    expect(mock.fresh).toHaveBeenCalledWith(id, {
      headers: { 'Cache-Control': 'no-cache' },
    });
  });

  it('keeps the draft after a transient background read failure', () => {
    const view = show();
    const name = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(name, { target: { value: 'My draft' } });
    mock.query.mockReturnValue({
      data: project,
      isError: true,
      error: new Error('Transient error'),
    });
    view.rerender(<ProjectSettingsPage projectId={id} />);
    expect(name).toHaveValue('My draft');
    expect(name).toBeVisible();
  });

  it('keeps the draft and blocks overwriting a name that changed elsewhere', async () => {
    mock.fresh.mockResolvedValue({ ...project, name: 'Renamed elsewhere' });
    show();
    const name = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(name, { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Project settings changed/,
    );
    expect(name).toHaveValue('My draft');
    expect(mock.patch).not.toHaveBeenCalled();
  });
});
