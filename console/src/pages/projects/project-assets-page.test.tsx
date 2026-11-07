import type { ProjectAssetDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAssetsPage } from './project-assets-page';

const mock = vi.hoisted(() => ({ permission: vi.fn(), assets: vi.fn() }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'fixture' } }),
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetAssets: mock.assets,
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
const asset: ProjectAssetDto = {
  id: '29c7b635-4793-4e90-bf56-9a2a2b2562d3',
  value: 'demo.argus.test',
  targetId: 'd59e5709-7834-4595-bcc6-3cc104795e5c',
  targetValue: 'argus.test',
  targetType: 'DOMAIN',
  source: 'rule',
  rule: {
    id: projectId,
    type: 'hostname',
    value: '*.argus.test',
    label: '*.argus.test',
  },
  addedAt: '2026-11-01T00:00:00Z',
  vulnerabilities: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
  lastScan: { runId, createdAt: '2026-11-02T00:00:00Z' },
};

describe('ProjectAssetsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.permission.mockReturnValue({
      hasPermission: (key: string) =>
        ['group.read', 'asset.read', 'job.read'].includes(key),
    });
    mock.assets.mockReturnValue({
      data: { data: [asset], hasNextPage: true, pageCount: 3 },
    });
  });

  it('shows membership evidence and authorized detail links', () => {
    render(
      <ProjectAssetsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(
      screen.getByRole('link', {
        name: 'demo.argus.test in target argus.test',
      }),
    ).toHaveAttribute('href', '/assets/services/' + asset.id);
    expect(
      screen.getByRole('link', {
        name: /latest run with demo.argus.test in scope/,
      }),
    ).toHaveAttribute('href', '/jobs/runs/' + runId);
    expect(screen.getByText('*.argus.test')).toBeVisible();
    expect(screen.getByText('2 high')).toBeVisible();
  });

  it('keeps evidence readable with only project read access', () => {
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    render(
      <ProjectAssetsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(screen.getByText('demo.argus.test')).toBeVisible();
    expect(
      screen.queryByRole('link', { name: /demo.argus.test/ }),
    ).not.toBeInTheDocument();
  });

  it('requests the selected page and opens the next one', () => {
    const onChange = vi.fn();
    render(
      <ProjectAssetsPage projectId={projectId} page={2} onChange={onChange} />,
    );
    expect(mock.assets).toHaveBeenCalledWith(
      projectId,
      { page: 2, limit: 20, sortOrder: 'DESC' },
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('gates the query before accessing project data', () => {
    mock.permission.mockReturnValue({ hasPermission: () => false });
    render(
      <ProjectAssetsPage projectId={projectId} page={1} onChange={vi.fn()} />,
    );
    expect(mock.assets).not.toHaveBeenCalled();
  });
});
