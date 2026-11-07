import type { ProjectRunDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRunsPage } from './project-runs-page';

const mock = vi.hoisted(() => ({
  workspace: vi.fn(),
  permission: vi.fn(),
  runs: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.workspace,
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetRuns: mock.runs,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
    'aria-label': label,
  }: {
    to: string;
    params: { id: string };
    children: ReactNode;
    'aria-label'?: string;
  }) => (
    <a href={to.replace('$id', params.id)} aria-label={label}>
      {children}
    </a>
  ),
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const run: ProjectRunDto = {
  id: 'd59e5709-7834-4595-bcc6-3cc104795e5c',
  createdAt: '2026-11-07T10:00:00Z',
  updatedAt: '2026-11-07T10:01:00Z',
  isCompleted: true,
  jobRunType: 'scheduled',
  projectWorkflowId: null,
  workflowName: 'Perimeter scan',
  status: 'completed',
  scopeSize: 3,
  stepsTotal: 4,
  stepsDone: 4,
  stepsFailed: 0,
  newVulnerabilities: 2,
  recurringVulnerabilities: 1,
};

describe('ProjectRunsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workspace.mockReturnValue({
      state: { selectedWorkspaceId: 'fixture' },
    });
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => ['group.read', 'job.read'].includes(key),
    });
    mock.runs.mockReturnValue({
      data: { data: [run], pageCount: 3, hasNextPage: true },
    });
  });

  it('shows the saved run, its findings, and its job detail link', () => {
    render(
      <ProjectRunsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(
      screen.getByRole('link', {
        name: /Perimeter scan, Scheduled, .*run d59e57/,
      }),
    ).toHaveAttribute('href', `/jobs/runs/${run.id}`);
    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.getByText('2 new · 1 recurring')).toBeVisible();
  });

  it('keeps project run summaries readable without exposing job detail links', () => {
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    render(
      <ProjectRunsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Perimeter scan')).toBeVisible();
    expect(
      screen.queryByRole('link', { name: /Perimeter scan/ }),
    ).not.toBeInTheDocument();
  });

  it('defers the runs request without project access or a valid project ID', () => {
    const { rerender } = render(
      <ProjectRunsPage projectId="bad-id" page={1} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Project not found')).toBeVisible();
    mock.permission.mockReturnValue({ hasPermission: () => false });
    rerender(
      <ProjectRunsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(
      screen.getByText(/don’t have permission|don't have permission/),
    ).toBeVisible();
    expect(mock.runs).not.toHaveBeenCalled();
  });

  it('preserves the trigger filter during paging and resets the page on filter changes', () => {
    const onChange = vi.fn();
    render(
      <ProjectRunsPage
        projectId={projectId}
        page={2}
        trigger="scheduled"
        onChange={onChange}
      />,
    );
    expect(mock.runs).toHaveBeenCalledWith(
      projectId,
      { page: 2, limit: 20, jobRunType: 'scheduled' },
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenLastCalledWith({
      page: 3,
      trigger: 'scheduled',
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Trigger' }), {
      target: { value: 'manual' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ page: 1, trigger: 'manual' });
  });
});
