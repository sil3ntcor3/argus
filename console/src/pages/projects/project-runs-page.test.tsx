import type { ProjectRunDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRunsPage } from './project-runs-page';

const mock = vi.hoisted(() => ({
  workspace: vi.fn(),
  permission: vi.fn(),
  runs: vi.fn(),
  project: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: mock.workspace,
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetRuns: mock.runs,
  useProjectsControllerGetById: mock.project,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    search,
    children,
    'aria-label': label,
  }: {
    to: string;
    params: { id: string };
    search?: Record<string, string>;
    children: ReactNode;
    'aria-label'?: string;
  }) => (
    <a
      href={
        to.replace('$id', params.id) +
        (search ? '?' + new URLSearchParams(search) : '')
      }
      aria-label={label}
    >
      {children}
    </a>
  ),
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const workflowId = 'ed5cfdd9-189e-49cf-a3d1-4f8a3e0a565d';
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
    mock.project.mockReturnValue({
      data: {
        assetGroupWorkflows: [
          { id: workflowId, workflow: { content: { name: 'Nightly scan' } } },
          { id: projectId, workflow: { content: { name: 'Manual scan' } } },
        ],
      },
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
    expect(screen.getByText('Duration 1m 0s')).toBeVisible();
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
      screen.queryByRole('link', { name: /^Perimeter scan,/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: /^View findings from this run, Perimeter scan,/,
      }),
    ).toHaveAttribute(
      'href',
      `/projects/${projectId}/findings?run=${run.id}&status=all`,
    );
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

  it('uses the workflow binding ID with the trigger filter and resets pagination', () => {
    const onChange = vi.fn();
    render(
      <ProjectRunsPage
        projectId={projectId}
        page={2}
        trigger="scheduled"
        workflow={workflowId}
        onChange={onChange}
      />,
    );
    expect(mock.runs).toHaveBeenCalledWith(
      projectId,
      {
        page: 2,
        limit: 20,
        jobRunType: 'scheduled',
        projectWorkflowId: workflowId,
      },
      expect.anything(),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), {
      target: { value: projectId },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      page: 1,
      trigger: 'scheduled',
      workflow: projectId,
    });
  });

  it('uses the saved name for a single binding without a content name', () => {
    mock.project.mockReturnValue({
      data: {
        assetGroupWorkflows: [
          { id: workflowId, workflow: { name: 'Nightly scan', content: {} } },
        ],
      },
    });
    render(
      <ProjectRunsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('option', { name: 'Nightly scan' })).toHaveValue(
      workflowId,
    );
  });

  it('keeps runs visible and allows retrying failed workflow choices', () => {
    const refetch = vi.fn();
    mock.project.mockReturnValue({ isError: true, refetch });
    render(
      <ProjectRunsPage
        projectId={projectId}
        page={1}
        workflow={workflowId}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('list', { name: 'Project runs' })).toBeVisible();
    expect(screen.getByText('Unable to load workflow choices')).toBeVisible();
    expect(
      screen.getByRole('option', { name: 'Workflow name unknown' }),
    ).toHaveValue(workflowId);
    fireEvent.click(screen.getByRole('button', { name: 'Retry workflows' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(screen.getByRole('combobox', { name: 'Workflow' })).toHaveFocus();
  });

  it('resets paging while preserving filters when the page size changes', () => {
    const onChange = vi.fn();
    render(
      <ProjectRunsPage
        projectId={projectId}
        page={2}
        trigger="scheduled"
        workflow={workflowId}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Runs per page' }), {
      target: { value: '50' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      page: 1,
      trigger: 'scheduled',
      workflow: workflowId,
      pageSize: 50,
    });
  });
  it('labels event runs and allows filtering to automatic events', () => {
    mock.runs.mockReturnValue({
      data: { data: [{ ...run, jobRunType: 'event' }], pageCount: 1 },
    });
    const onChange = vi.fn();
    render(
      <ProjectRunsPage projectId={projectId} page={1} onChange={onChange} />,
    );
    expect(
      screen.getByRole('link', { name: /Perimeter scan, Event,/ }),
    ).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'Trigger' }), {
      target: { value: 'event' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'event', page: 1 }),
    );
  });
});
