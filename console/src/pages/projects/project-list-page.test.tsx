import { fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectListPage } from './project-list-page';

const mock = vi.hoisted(() => ({
  permission: vi.fn(),
  workspace: vi.fn(),
  projects: vi.fn(),
  hasPermission: vi.fn<(key: string) => boolean>(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.workspace,
}));
vi.mock('@/services/apis/gen/queries', () => ({
  useProjectsControllerGetMany: mock.projects,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params: { id: string };
    children: ReactNode;
  }) => <a href={to.replace('$id', params.id)}>{children}</a>,
}));

const id = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const data = {
  data: [
    { id, name: 'Perimeter', description: 'Public services', totalAssets: 4 },
  ],
  total: 13,
  pageCount: 2,
};

function ListHarness() {
  const [params, setParams] = useState({ page: 1, search: '' });
  return <ProjectListPage {...params} onChange={setParams} />;
}

describe('ProjectListPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workspace.mockReturnValue({
      state: { selectedWorkspaceId: 'workspace-1' },
    });
    mock.permission.mockReturnValue({
      hasPermission: mock.hasPermission,
      isLoading: false,
    });
    mock.hasPermission.mockImplementation((key) => key === 'project.read');
    mock.projects.mockReturnValue({ data });
  });

  it.each(['project.read', 'group.read'])(
    'shows cards with %s',
    (permission) => {
      mock.hasPermission.mockImplementation((key) => key === permission);
      render(<ListHarness />);
      expect(screen.getByText('Perimeter')).toBeVisible();
      expect(screen.getByText('Public services')).toBeVisible();
      expect(screen.getByRole('link', { name: 'Perimeter' })).toHaveAttribute(
        'href',
        `/projects/${id}`,
      );
    },
  );

  it('does not load or show projects without read permission', () => {
    mock.hasPermission.mockReturnValue(false);
    render(<ListHarness />);
    expect(
      screen.getByText("You don't have permission to access this page"),
    ).toBeVisible();
    expect(screen.queryByText('Perimeter')).not.toBeInTheDocument();
    expect(mock.projects).not.toHaveBeenCalled();
  });

  it('requests the next page and restarts paging on a new search', () => {
    render(<ListHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(mock.projects.mock.lastCall?.[0]).toMatchObject({
      page: 2,
      limit: 12,
    });
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search projects' }),
      {
        target: { value: '  perimeter  ' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(mock.projects.mock.lastCall?.[0]).toMatchObject({
      page: 1,
      search: 'perimeter',
    });
  });

  it('distinguishes an empty workspace from a search with no matches', () => {
    mock.projects.mockReturnValue({
      data: { data: [], total: 0, pageCount: 0 },
    });
    render(<ListHarness />);
    expect(screen.getByText('No projects yet')).toBeVisible();
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search projects' }),
      {
        target: { value: 'missing' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('No matching projects')).toBeVisible();
  });

  it('hides a cached list if the current request fails', () => {
    const refetch = vi.fn();
    mock.projects.mockReturnValue({ data, isError: true, refetch });
    render(<ListHarness />);
    expect(screen.getByText('Unable to load projects')).toBeVisible();
    expect(screen.queryByText('Perimeter')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});
