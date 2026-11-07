import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectOverviewPage } from './project-overview-page';

const mock = vi.hoisted(() => ({
  usePermission: vi.fn(),
  useWorkspaceState: vi.fn(),
  useProject: vi.fn(),
  useOverview: vi.fn(),
  hasPermission: vi.fn<(key: string) => boolean>(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.usePermission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.useWorkspaceState,
}));
vi.mock(import('@/services/apis/gen/queries'), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjectsControllerGetById: mock.useProject,
  useProjectsControllerGetOverview: mock.useOverview,
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const metadata = { name: 'Perimeter project', description: 'Public services' };
const overview = {
  totalAssets: 12,
  newAssets: 1,
  workflows: 3,
  newVulnerabilities: 2,
  openVulnerabilities: { critical: 3, high: 2, medium: 1, low: 1, info: 1 },
  weekly: [],
  lastRun: null,
  newVulnerabilityRuns: [],
  activity: [],
};

describe('ProjectOverviewPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.useWorkspaceState.mockReturnValue({
      state: { selectedWorkspaceId: 'fixture-workspace' },
    });
    mock.usePermission.mockReturnValue({
      hasPermission: mock.hasPermission,
      isLoading: false,
    });
    mock.hasPermission.mockImplementation((key) => key === 'project.read');
    mock.useProject.mockReturnValue({ data: metadata, isPending: false });
    mock.useOverview.mockReturnValue({ data: overview, isPending: false });
  });

  it('defers both project requests until permission is resolved', () => {
    mock.usePermission.mockReturnValue({
      hasPermission: mock.hasPermission,
      isLoading: true,
    });
    render(<ProjectOverviewPage projectId={projectId} />);
    expect(
      screen.getByRole('status', { name: 'Loading project overview' }),
    ).toBeVisible();
    const disabled = expect.objectContaining({
      query: expect.objectContaining({ enabled: false }),
    });
    expect(mock.useProject).toHaveBeenCalledWith(projectId, disabled);
    expect(mock.useOverview).toHaveBeenCalledWith(projectId, disabled);
    expect(screen.queryByText(metadata.name)).not.toBeInTheDocument();
  });

  it('hides project data when neither read permission is granted', () => {
    mock.hasPermission.mockReturnValue(false);
    render(<ProjectOverviewPage projectId={projectId} />);
    expect(
      screen.getByText("You don't have permission to access this page"),
    ).toBeVisible();
    expect(screen.queryByText(metadata.name)).not.toBeInTheDocument();
    expect(mock.useOverview).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        query: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it.each(['project.read', 'group.read'])(
    'shows the same summary with %s',
    (permission) => {
      mock.hasPermission.mockImplementation((key) => key === permission);
      render(<ProjectOverviewPage projectId={projectId} />);
      expect(screen.getByText(metadata.name)).toBeVisible();
      expect(screen.getByText(metadata.description)).toBeVisible();
      expect(
        screen.getByRole('heading', { name: 'Project summary' }),
      ).toBeVisible();
      expect(screen.getByText('Assets', { exact: true })).toBeVisible();
      expect(screen.getByText('Open findings', { exact: true })).toBeVisible();
      for (const count of [12, 3, 8, 2])
        expect(screen.getByText(String(count), { exact: true })).toBeVisible();
      const enabled = expect.objectContaining({
        query: expect.objectContaining({ enabled: true }),
      });
      expect(mock.useProject).toHaveBeenCalledWith(projectId, enabled);
      expect(mock.useOverview).toHaveBeenCalledWith(projectId, enabled);
    },
  );

  it('shows a not-found state without exposing an earlier cached project name', () => {
    mock.useOverview.mockReturnValue({
      isError: true,
      error: { isAxiosError: true, response: { status: 404 } },
    });
    render(<ProjectOverviewPage projectId={projectId} />);
    expect(screen.getByText('Project not found')).toBeVisible();
    expect(screen.queryByText(metadata.name)).not.toBeInTheDocument();
  });

  it('does not request a decoded route parameter that is not a UUID', () => {
    const invalidId = '../workspaces?';
    render(<ProjectOverviewPage projectId={invalidId} />);
    expect(screen.getByText('Project not found')).toBeVisible();
    expect(screen.queryByText(metadata.name)).not.toBeInTheDocument();
    const disabled = expect.objectContaining({
      query: expect.objectContaining({ enabled: false }),
    });
    expect(mock.useProject).toHaveBeenCalledWith(invalidId, disabled);
    expect(mock.useOverview).toHaveBeenCalledWith(invalidId, disabled);
  });
});
