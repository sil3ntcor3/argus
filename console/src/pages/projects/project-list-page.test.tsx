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
vi.mock('./project-archive-dialog', () => ({ ProjectArchiveDialog: () => null }));
vi.mock(import('@/services/apis/gen/queries'), async original => ({ ...(await original()), useProjectsControllerGetMany: mock.projects }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: { id: string };
    children: ReactNode;
  }) => <a href={to.replace('$id', params?.id ?? '')}>{children}</a>,
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

  it('resets pagination when switching archived filters and preserves it during search', () => {
    render(<ListHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project status' }), { target: { value: 'archived' } });
    expect(mock.projects.mock.lastCall?.[0]).toMatchObject({ page: 1, status: 'archived' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'perimeter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(mock.projects.mock.lastCall?.[0]).toMatchObject({ page: 1, status: 'archived', search: 'perimeter' });
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

  it('shows workflow, finding and trigger summaries for authorized readers', () => {
    mock.hasPermission.mockReturnValue(true);
    mock.projects.mockReturnValue({ data: { ...data, data: [{ ...data.data[0], workflowCount: 2,
      newVulnerabilities: 3, openVulnerabilities: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
      triggers: [{ id: 'tr', projectWorkflowId: 'binding', type: 'event', event: 'project.run.completed', enabled: true }] }] } });
    render(<ListHarness />);
    expect(screen.getByText('Workflows')).toBeVisible();
    expect(screen.getByLabelText('Open findings by severity')).toHaveTextContent('1 critical');
    expect(screen.getByText('+3 new')).toBeVisible();
    expect(screen.getByText('Run completed')).toBeVisible();
  });

  it('hides cached finding counts and risk sort without finding access', () => {
    mock.projects.mockReturnValue({ data: { ...data, data: [{ ...data.data[0], workflowCount: 0, triggers: [],
      newVulnerabilities: 3, openVulnerabilities: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } }] } });
    render(<ListHarness />);
    expect(screen.queryByText('+3 new')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Open findings by severity')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Highest risk' })).not.toBeInTheDocument();
  });

  it('resets paging and retains search and archive choices when sorting', () => {
    mock.hasPermission.mockReturnValue(true);
    render(<ListHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort projects' }), { target: { value: 'risk' } });
    expect(mock.projects.mock.lastCall?.[0]).toMatchObject({ page: 1, sortBy: 'risk', sortOrder: 'DESC' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project status' }), { target: { value: 'all' } });
    expect(mock.projects.mock.lastCall?.[0]).toMatchObject({ page: 1, status: 'all', sortBy: 'risk', sortOrder: 'DESC' });
  });

  it('defers risk reads until permissions refresh, then offers a safe name-sort recovery', () => {
    const onChange = vi.fn();
    mock.permission.mockReturnValue({ hasPermission: mock.hasPermission, isFetching: true });
    const { rerender } = render(<ProjectListPage page={2} search="perimeter" sort="risk" status="all" onChange={onChange} />);
    expect(screen.getByRole('status', { name: 'Loading projects' })).toBeVisible();
    expect(mock.projects).not.toHaveBeenCalled();
    mock.permission.mockReturnValue({ hasPermission: mock.hasPermission, isFetching: false });
    rerender(<ProjectListPage page={2} search="perimeter" sort="risk" status="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by name' }));
    expect(onChange).toHaveBeenCalledWith({ page: 1, search: 'perimeter', status: 'all', sort: 'name' });
    expect(mock.projects).not.toHaveBeenCalled();
  });

  it('shows archived triggers as off and hides the fresh-findings badge', () => {
    mock.hasPermission.mockReturnValue(true);
    mock.projects.mockReturnValue({ data: { ...data, data: [{ ...data.data[0], archivedAt: '2026-01-01T00:00:00Z',
      newVulnerabilities: 3, openVulnerabilities: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      triggers: [{ id: 'tr', type: 'cron', cron: '0 8 * * *', enabled: true }] }] } });
    render(<ListHarness />);
    expect(screen.getByText('Triggers off')).toBeVisible();
    expect(screen.queryByText('+3 new')).not.toBeInTheDocument();
    expect(screen.queryByText(/Next scheduled/)).not.toBeInTheDocument();
  });

  it('keeps month-restricted schedules visible without inventing a next time', () => {
    mock.projects.mockReturnValue({ data: { ...data, data: [{ ...data.data[0],
      triggers: [{ id: 'annual', type: 'cron', cron: '0 8 * 12 *', enabled: true },
        { id: 'daily', type: 'cron', cron: '0 9 * * *', enabled: true }] }] } });
    render(<ListHarness />);
    expect(screen.getByText('Schedule', { exact: true })).toBeVisible();
    expect(screen.queryByText(/Next scheduled/)).not.toBeInTheDocument();
  });

  it('does not imply legacy schedules are manual-only when no trigger is summarized', () => {
    render(<ListHarness />);
    expect(screen.getByText('No enabled triggers')).toBeVisible();
    expect(screen.queryByText('Manual launch')).not.toBeInTheDocument();
  });
});
