import type { ProjectFindingDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectFindingsPage } from './project-findings-page';

const mock = vi.hoisted(() => ({
  permission: vi.fn(),
  findings: vi.fn(),
  project: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'fixture' } }),
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetFindings: mock.findings,
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
    mock.project.mockReturnValue({ data: { assetGroupWorkflows: [] } });
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

  it('offers lifecycle filters and resets paging without losing the active facets', () => {
    const onChange = vi.fn();
    render(<ProjectFindingsPage projectId={projectId} page={3} query="redirect" severity={['high']}
      provenance="recurring" onChange={onChange} />);
    expect(screen.getByRole('option', { name: 'Fixed' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Resurfaced' })).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'fixed' } });
    expect(onChange).toHaveBeenLastCalledWith({ page: 1, query: 'redirect', severity: ['high'], provenance: 'recurring', status: 'fixed' });
  });

  it('labels scan-fixed findings independently of their provenance', () => {
    mock.findings.mockReturnValue({ data: { data: [{ ...finding, status: 'fixed' }] } });
    render(<ProjectFindingsPage projectId={projectId} page={1} status="all" onChange={vi.fn()} />);
    expect(screen.getByText('Fixed', { selector: 'span' })).toBeVisible();
    expect(screen.getByText('Recurring ×3')).toBeVisible();
  });

  it.each([['pending_review', 'Pending review'], ['rejected', 'Rejected']] as const)(
    'labels %s results and hides approved-only run timeline actions', (status, label) => {
      render(<ProjectFindingsPage projectId={projectId} page={1} status={status} onChange={vi.fn()} />);
      expect(screen.getByRole('combobox', { name: 'Status' })).toHaveDisplayValue(label);
      expect(screen.getByText(label, { selector: 'span' })).toBeVisible();
      expect(screen.queryByRole('button', { name: /View timeline/ })).not.toBeInTheDocument();
    },
  );

  it('does not offer review-only statuses to project-only readers', () => {
    mock.permission.mockReturnValue({ hasPermission: (key: string) => key === 'project.read' });
    render(<ProjectFindingsPage projectId={projectId} page={1} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Fixed' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Pending review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Rejected' })).not.toBeInTheDocument();
  });

  it('blocks review-only queries before rendering cached data for project-only readers', () => {
    mock.permission.mockReturnValue({ hasPermission: (key: string) => key === 'project.read' });
    render(<ProjectFindingsPage projectId={projectId} page={1} status="pending_review" onChange={vi.fn()} />);
    expect(mock.findings).not.toHaveBeenCalled();
    expect(screen.queryByText('Open redirect')).not.toBeInTheDocument();
  });

  it('waits for an in-flight permission refresh before mounting review queries', () => {
    mock.permission.mockReturnValue({ isFetching: true, hasPermission: () => true });
    render(<ProjectFindingsPage projectId={projectId} page={1} status="pending_review" onChange={vi.fn()} />);
    expect(mock.findings).not.toHaveBeenCalled();
    expect(screen.getByText('Loading project access')).toBeVisible();
    expect(screen.queryByText('Open redirect')).not.toBeInTheDocument();
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
  it('passes literal search terms with the active facets and resets paging', () => {
    const onChange = vi.fn();
    render(
      <ProjectFindingsPage
        projectId={projectId}
        page={2}
        provenance="recurring"
        query="CVE-2026-1234"
        onChange={onChange}
      />,
    );
    expect(mock.findings).toHaveBeenCalledWith(
      projectId,
      { page: 2, limit: 20, provenance: 'recurring', search: 'CVE-2026-1234' },
      expect.anything(),
    );
    const input = screen.getByRole('searchbox', { name: 'Search findings' });
    expect(input).toHaveValue('CVE-2026-1234');
    fireEvent.change(input, { target: { value: '  100%_  ' } });
    fireEvent.submit(
      screen.getByRole('search', { name: 'Project findings search' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      page: 1,
      query: '  100%_  ',
      provenance: 'recurring',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenLastCalledWith({
      page: 1,
      provenance: 'recurring',
    });
  });
  it('filters by the selected run and preserves search and facets when clearing it', () => {
    const onChange = vi.fn();
    const run = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';
    render(
      <ProjectFindingsPage
        projectId={projectId}
        page={2}
        run={run}
        query="redirect"
        status="all"
        severity={['medium']}
        onChange={onChange}
      />,
    );
    expect(mock.findings).toHaveBeenCalledWith(
      projectId,
      {
        page: 2,
        limit: 20,
        jobHistoryId: run,
        search: 'redirect',
        status: 'all',
        severity: ['medium'],
      },
      expect.anything(),
    );
    expect(screen.getByText('Run e13a3774')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenLastCalledWith({
      page: 3,
      run,
      query: 'redirect',
      status: 'all',
      severity: ['medium'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear run filter' }));
    expect(onChange).toHaveBeenLastCalledWith({
      page: 1,
      query: 'redirect',
      status: 'all',
      severity: ['medium'],
    });
  });
  it('sends a binding ID alongside the run filter and resets only the page when changed', () => {
    const workflow = '29c7b635-4793-4e90-bf56-9a2a2b2562d3';
    const run = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';
    const onChange = vi.fn();
    mock.project.mockReturnValue({
      data: {
        assetGroupWorkflows: [
          { id: workflow, workflow: { name: 'Scheduled test' } },
        ],
      },
    });
    render(
      <ProjectFindingsPage
        projectId={projectId}
        page={2}
        run={run}
        workflow={workflow}
        query="redirect"
        status="all"
        onChange={onChange}
      />,
    );
    expect(mock.findings).toHaveBeenCalledWith(
      projectId,
      {
        page: 2,
        limit: 20,
        jobHistoryId: run,
        projectWorkflowId: workflow,
        search: 'redirect',
        status: 'all',
      },
      expect.anything(),
    );
    const selector = screen.getByRole('combobox', { name: 'Workflow' });
    expect(selector).toHaveDisplayValue('Scheduled test');
    fireEvent.change(selector, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({
      page: 1,
      run,
      query: 'redirect',
      status: 'all',
    });
  });
});
