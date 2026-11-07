import type { ProjectFindingDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectFindingsPage } from './project-findings-page';

const mock = vi.hoisted(() => ({
  permission: vi.fn(),
  findings: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'fixture' } }),
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetFindings: mock.findings,
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
const finding: ProjectFindingDto = {
  id: 'd59e5709-7834-4595-bcc6-3cc104795e5c',
  name: 'Open redirect',
  severity: 'medium',
  cveId: null,
  affectedUrl: null,
  assetId: 'ed5cfdd9-189e-49cf-a3d1-4f8a3e0a565d',
  assetValue: 'argus.example.test',
  toolName: 'nuclei',
  status: 'open',
  provenance: 'recurring',
  timesSeen: 3,
  firstSeen: { at: '2026-10-01T00:00:00Z', runId: null },
  lastSeen: { at: '2026-11-01T00:00:00Z', runId: null },
};

describe('ProjectFindingsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.permission.mockReturnValue({
      hasPermission: (key: string) =>
        ['group.read', 'vulnerability.read'].includes(key),
    });
    mock.findings.mockReturnValue({
      data: { data: [finding], hasNextPage: true, pageCount: 3 },
    });
  });

  it('shows project provenance and links readers to the workspace finding', () => {
    render(
      <ProjectFindingsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(
      screen.getByRole('link', { name: 'Open redirect on argus.example.test' }),
    ).toHaveAttribute('href', '/vulnerabilities/' + finding.id);
    expect(screen.getByText('Recurring ×3')).toBeVisible();
    expect(screen.getByText('argus.example.test · nuclei')).toBeVisible();
  });

  it('keeps findings readable without the workspace finding permission', () => {
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    render(
      <ProjectFindingsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Open redirect')).toBeVisible();
    expect(
      screen.queryByRole('link', {
        name: 'Open redirect on argus.example.test',
      }),
    ).not.toBeInTheDocument();
  });

  it('gates the query before accessing project data', () => {
    mock.permission.mockReturnValue({ hasPermission: () => false });
    render(
      <ProjectFindingsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(mock.findings).not.toHaveBeenCalled();
  });

  it('preserves provenance during paging and resets the page on change', () => {
    const onChange = vi.fn();
    render(
      <ProjectFindingsPage
        projectId={projectId}
        page={2}
        provenance="recurring"
        onChange={onChange}
      />,
    );
    expect(mock.findings).toHaveBeenCalledWith(
      projectId,
      { page: 2, limit: 20, provenance: 'recurring' },
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenLastCalledWith({
      page: 3,
      provenance: 'recurring',
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Provenance' }), {
      target: { value: 'new' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ page: 1, provenance: 'new' });
  });

  it('keeps status and multiple severities in the query and exposes independent facet counts', () => {
    mock.findings.mockReturnValue({
      data: {
        data: [{ ...finding, status: 'dismissed' }],
        provenanceCounts: { all: 7, new: 4, recurring: 2, notSeen: 1 },
        severityCounts: { critical: 2, high: 1, medium: 1, low: 0, info: 3 },
      },
    });
    const onChange = vi.fn();
    render(
      <ProjectFindingsPage
        projectId={projectId}
        page={1}
        provenance="recurring"
        status="dismissed"
        severity={['high', 'medium']}
        onChange={onChange}
      />,
    );
    expect(mock.findings).toHaveBeenCalledWith(
      projectId,
      {
        page: 1,
        limit: 20,
        provenance: 'recurring',
        severity: ['high', 'medium'],
        status: 'dismissed',
      },
      expect.anything(),
    );
    expect(
      screen.getByRole('combobox', { name: 'Provenance' }),
    ).toHaveDisplayValue('Recurring (2)');
    expect(screen.getByText('Dismissed', { selector: 'span' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'high (1)' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'critical (2)' }));
    expect(onChange).toHaveBeenLastCalledWith({
      page: 1,
      provenance: 'recurring',
      severity: ['critical', 'high', 'medium'],
      status: 'dismissed',
    });
  });
});
