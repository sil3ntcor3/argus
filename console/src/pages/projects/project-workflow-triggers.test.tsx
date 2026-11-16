import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowsPage } from './project-workflows-page';

const mock = vi.hoisted(() => ({
  project: vi.fn(),
  triggers: vi.fn(),
  workspace: vi.fn(),
  permission: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.workspace,
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetById: mock.project,
  useProjectsControllerGetWorkflows: () => ({ ...mock.project(), data: mock.project().data?.assetGroupWorkflows }),
  useProjectsControllerGetTriggers: mock.triggers,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const cron = {
  id: 'cron',
  projectWorkflowId: 'discovery',
  type: 'cron',
  cron: '0 8 * 1 *',
  event: null,
  config: {},
  enabled: false,
  lastFiredAt: null,
};
const event = {
  ...cron,
  id: 'event',
  type: 'event',
  cron: null,
  event: 'project.assets.added',
  enabled: true,
  config: { windowMinutes: 0, maxAssets: 7 },
  lastFiredAt: '2026-11-12T10:00:00Z',
};
const region = () =>
  within(screen.getByRole('region', { name: 'Triggers for Discovery' }));

describe('Project workflow trigger visibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workspace.mockReturnValue({
      state: { selectedWorkspaceId: 'workspace-a' },
    });
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    mock.project.mockReturnValue({
      data: {
        assetGroupWorkflows: [
          {
            id: 'discovery',
            workflow: { name: 'Discovery' },
            schedule: 'disabled',
          },
          {
            id: 'other',
            workflow: { name: 'Other workflow' },
            schedule: '0 6 * * *',
          },
        ],
      },
    });
    mock.triggers.mockReturnValue({
      data: [
        cron,
        event,
        {
          ...cron,
          id: 'other-cron',
          projectWorkflowId: 'other',
          cron: '0 3 * 1 *',
        },
      ],
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
  });

  it('shows each binding’s saved triggers from one project query, alongside legacy schedules', () => {
    render(<ProjectWorkflowsPage projectId={projectId.toUpperCase()} />);
    expect(mock.triggers).toHaveBeenCalledTimes(1);
    expect(mock.triggers).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        query: expect.objectContaining({ enabled: true, retry: false }),
      }),
    );
    expect(region().getByText('0 8 * 1 * UTC')).toBeVisible();
    expect(region().getByText('When assets are added')).toBeVisible();
    expect(region().getByText('Disabled')).toBeVisible();
    expect(region().getByText('Enabled')).toBeVisible();
    expect(region().queryByText('0 3 * 1 * UTC')).toBeNull();
    expect(screen.getByText('Schedule disabled')).toBeVisible();
    expect(screen.getByText('Every day at 6:00 AM (UTC)')).toBeVisible();
    expect(region().getByText('Never fired')).toBeVisible();
    expect(
      region()
        .getByText(/Last fired/)
        .querySelector('time'),
    ).toHaveAttribute('dateTime', event.lastFiredAt);
    expect(region().getByText('Gather 0 min · Up to 7 assets')).toBeVisible();
    expect(region().queryByRole('switch')).toBeNull();
  });

  it('labels the other event types and keeps raw unsupported schedules readable', () => {
    mock.triggers.mockReturnValue({
      ...mock.triggers(),
      data: [
        {
          ...event,
          id: 'completed',
          event: 'project.run.completed',
          config: {},
        },
        {
          ...event,
          id: 'finding',
          event: 'vulnerability.detected',
          config: {},
        },
        { ...cron, id: 'raw', cron: '*/7 * * * *' },
      ],
    });
    render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(
      region().getByText('After a project workflow finishes'),
    ).toBeVisible();
    expect(region().getByText('When a vulnerability is found')).toBeVisible();
    expect(region().getByText('*/7 * * * * UTC')).toBeVisible();
  });

  it('renders empty and loading states without suggesting that legacy schedules are off', () => {
    mock.triggers.mockReturnValue({ ...mock.triggers(), data: [] });
    const view = render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(region().getByText('No triggers configured')).toBeVisible();
    mock.triggers.mockReturnValue({ isPending: true, data: undefined });
    view.rerender(<ProjectWorkflowsPage projectId={projectId} />);
    expect(region().getByLabelText('Loading workflow triggers')).toBeVisible();
    expect(region().queryByText('No triggers configured')).toBeNull();
  });

  it.each([
    [401, 'Access to workflow triggers was denied'],
    [403, 'Access to workflow triggers was denied'],
    [404, 'Project triggers not found'],
  ])(
    'hides cached rows and retry controls after HTTP %s',
    (status, message) => {
      mock.triggers.mockReturnValue({
        ...mock.triggers(),
        isError: true,
        error: { isAxiosError: true, response: { status } },
      });
      render(<ProjectWorkflowsPage projectId={projectId} />);
      expect(region().getByRole('status')).toHaveTextContent(message);
      expect(region().queryByText('When assets are added')).toBeNull();
      expect(region().queryByRole('button')).toBeNull();
    },
  );

  it('offers explicit retry on a server error and disables it during the request', () => {
    const query = {
      ...mock.triggers(),
      isError: true,
      error: new Error('offline'),
    };
    mock.triggers.mockReturnValue(query);
    const view = render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(region().getByRole('status')).toHaveTextContent(
      'Unable to load workflow triggers',
    );
    fireEvent.click(
      region().getByRole('button', { name: 'Retry triggers for Discovery' }),
    );
    expect(query.refetch).toHaveBeenCalledTimes(1);
    mock.triggers.mockReturnValue({ ...query, isFetching: true });
    view.rerender(<ProjectWorkflowsPage projectId={projectId} />);
    expect(region().getByRole('button')).toBeDisabled();
    expect(region().queryByText('When assets are added')).toBeNull();
  });

  it('clears the rendered list when switching workspace or project', () => {
    const view = render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(region().getByText('When assets are added')).toBeVisible();
    mock.workspace.mockReturnValue({
      state: { selectedWorkspaceId: 'workspace-b' },
    });
    mock.triggers.mockReturnValue({ isPending: true, data: undefined });
    view.rerender(
      <ProjectWorkflowsPage projectId="97e74c18-e145-41cb-bb7a-7cc16f9c0721" />,
    );
    expect(region().queryByText('When assets are added')).toBeNull();
    expect(region().getByLabelText('Loading workflow triggers')).toBeVisible();
  });

  it.each(['no workspace', 'no permission', 'invalid project'])(
    'does not query with %s',
    (missing) => {
      if (missing === 'no workspace')
        mock.workspace.mockReturnValue({ state: {} });
      if (missing === 'no permission')
        mock.permission.mockReturnValue({ hasPermission: () => false });
      render(
        <ProjectWorkflowsPage
          projectId={missing === 'invalid project' ? 'invalid' : projectId}
        />,
      );
      expect(mock.triggers).not.toHaveBeenCalled();
    },
  );
});
