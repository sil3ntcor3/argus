import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parse } from 'yaml';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowsPage } from './project-workflows-page';

const mock = vi.hoisted(() => ({ project: vi.fn(), permission: vi.fn() }));

vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'fixture' } }),
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetById: mock.project,
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
const runId = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';

describe('ProjectWorkflowsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => ['group.read', 'job.read'].includes(key),
    });
    mock.project.mockReturnValue({
      data: {
        assetGroupWorkflows: [
          {
            id: 'binding-1',
            workflow: {
              name: 'Discovery',
              content: {
                name: 'Old label',
                jobs: {
                  consume: { run: 'httpx', needs: ['scan'] },
                  scan: { run: 'naabu' },
                },
              },
            },
            schedule: '0 8 * 1 *',
            lastRun: {
              id: runId,
              status: 'completed',
              createdAt: '2026-11-02T00:00:00Z',
            },
          },
          {
            id: 'binding-2',
            workflow: { content: { name: 'Manual scan' } },
            schedule: 'disabled',
          },
        ],
      },
    });
  });

  it('shows saved labels, schedules and accessible run detail links', () => {
    render(<ProjectWorkflowsPage projectId={projectId.toUpperCase()} />);
    expect(mock.project).toHaveBeenCalledWith(projectId, expect.anything());
    expect(screen.getByRole('heading', { name: 'Discovery' })).toBeVisible();
    expect(screen.getByText('0 8 * 1 * UTC')).toBeVisible();
    expect(screen.getByText('Schedule disabled')).toBeVisible();
    expect(
      screen.getByRole('link', { name: /latest run for Discovery/i }),
    ).toHaveAttribute('href', '/jobs/runs/' + runId);
    expect(screen.getByText('No run summary available')).toBeVisible();
  });

  it('shows run evidence without a link when job read is absent', () => {
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.queryByRole('link', { name: /latest run/i })).toBeNull();
  });

  it('opens the selected workflow as YAML in dependency order and restores focus', async () => {
    render(<ProjectWorkflowsPage projectId={projectId} />);
    const trigger = screen.getByRole('button', {
      name: 'View workflow for Discovery',
    });
    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Workflow definition' });
    const source = sheet.querySelector('pre')?.textContent ?? '';
    expect(parse(source)).toEqual({
      name: 'Old label',
      jobs: {
        scan: { run: 'naabu' },
        consume: { run: 'httpx', needs: ['scan'] },
      },
    });
    expect(source.indexOf('scan:')).toBeLessThan(source.indexOf('consume:'));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('does not query when project access is missing', () => {
    mock.permission.mockReturnValue({ hasPermission: () => false });
    render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(mock.project).not.toHaveBeenCalled();
  });
});
