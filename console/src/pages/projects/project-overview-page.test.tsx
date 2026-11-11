import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectOverviewPage } from './project-overview-page';

const mock = vi.hoisted(() => ({
  usePermission: vi.fn(),
  useWorkspaceState: vi.fn(),
  useProject: vi.fn(),
  useOverview: vi.fn(),
  useFindings: vi.fn(),
  useTimeline: vi.fn(),
  hasPermission: vi.fn<(key: string) => boolean>(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.usePermission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.useWorkspaceState,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    'aria-label': label,
    'aria-describedby': describedBy,
  }: ComponentProps<'a'>) => (
    <a href="/runs" aria-label={label} aria-describedby={describedBy}>
      {children}
    </a>
  ),
}));
vi.mock(import('@/services/apis/gen/queries'), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjectsControllerGetById: mock.useProject,
  useProjectsControllerGetOverview: mock.useOverview,
  useProjectsControllerGetFindings: mock.useFindings,
  useProjectsControllerGetFindingTimeline: mock.useTimeline,
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
    mock.useFindings.mockReturnValue({ data: { data: [] } });
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
    expect(mock.useFindings).not.toHaveBeenCalled();
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
    expect(mock.useFindings).not.toHaveBeenCalled();
  });

  it.each(['project.read', 'group.read'])(
    'shows the same summary with %s',
    (permission) => {
      mock.hasPermission.mockImplementation((key) => key === permission);
      render(<ProjectOverviewPage projectId={projectId} />);
      expect(screen.getByText(metadata.name)).toBeVisible();
      expect(screen.getByText(metadata.description)).toBeVisible();
      const summary = within(
        screen.getByRole('region', { name: 'Project summary' }),
      );
      expect(summary.getByText('Assets', { exact: true })).toBeVisible();
      expect(summary.getByText('Open findings', { exact: true })).toBeVisible();
      for (const count of [12, 3, 8, 2])
        expect(summary.getByText(String(count), { exact: true })).toBeVisible();
      expect(
        screen.getByRole('link', { name: 'View project assets' }),
      ).toHaveAccessibleDescription('12');
      expect(
        screen.getByRole('link', { name: 'View open findings' }),
      ).toHaveAccessibleDescription('8');
      expect(
        screen.getByRole('link', { name: 'View project workflows' }),
      ).toHaveAccessibleDescription('3');
      const enabled = expect.objectContaining({
        query: expect.objectContaining({ enabled: true }),
      });
      expect(mock.useProject).toHaveBeenCalledWith(projectId, enabled);
      expect(mock.useOverview).toHaveBeenCalledWith(projectId, enabled);
      expect(mock.useFindings).toHaveBeenCalledWith(
        projectId,
        { page: 1, limit: 15, status: 'open' },
        { query: { enabled: true, retry: false } },
      );
    },
  );

  it('uses the empty overview count without fetching the findings preview', () => {
    mock.useOverview.mockReturnValue({
      data: {
        ...overview,
        openVulnerabilities: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          info: 0,
        },
      },
      isPending: false,
    });
    render(<ProjectOverviewPage projectId={projectId} />);
    expect(screen.getByRole('region', { name: 'To fix' })).toHaveTextContent(
      'No open findings',
    );
    expect(mock.useFindings).toHaveBeenCalledWith(
      projectId,
      { page: 1, limit: 15, status: 'open' },
      { query: { enabled: false, retry: false } },
    );
  });

  it('closes the timeline when changing projects that share a finding', () => {
    mock.useFindings.mockReturnValue({
      data: {
        data: [
          {
            id: '2b9dc595-c82b-4b67-b96c-0b3813eae0c1',
            name: 'Shared finding',
            assetValue: 'fixture.example.test',
            severity: 'high',
            provenance: 'new',
          },
        ],
      },
    });
    mock.useTimeline.mockReturnValue({ data: { runs: [] } });
    const { rerender } = render(<ProjectOverviewPage projectId={projectId} />);
    fireEvent.click(
      screen.getByRole('button', { name: /View timeline for Shared finding/ }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Shared finding' }),
    ).toBeVisible();

    mock.useTimeline.mockClear();
    rerender(
      <ProjectOverviewPage projectId="708c764f-9c9a-49b6-a5a9-17297a5c68df" />,
    );
    expect(
      screen.queryByRole('dialog', { name: 'Shared finding' }),
    ).not.toBeInTheDocument();
    expect(mock.useTimeline).not.toHaveBeenCalled();
  });

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
