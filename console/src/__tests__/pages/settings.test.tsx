import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import Settings, { filterTabGroups, settingsTabGroups } from '@/pages/settings/settings';
import { useParams } from '@tanstack/react-router';

const files = vi.hoisted(() => ({
  list: vi.fn(),
  usage: vi.fn(),
}));

vi.mock('@/services/apis/gen/queries', async (original) => ({
  ...(await original<typeof import('@/services/apis/gen/queries')>()),
  useArtifactsControllerGetMany: files.list,
  useArtifactsControllerGetUsage: files.usage,
}));

vi.mock('@/hooks/useWorkspaceSelector', async (original) => ({
  ...(await original<typeof import('@/hooks/useWorkspaceSelector')>()),
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'workspace-fixture' } }),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router');
  return {
    ...actual,
    useParams: vi.fn(() => ({ tab: 'general' })),
  };
});

vi.mock('@/utils/authClient', () => ({
  useSession: vi.fn(() => ({
    data: { user: { id: 'user-1', role: 'admin' } },
  })),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: vi.fn(() => ({
    permissions: ['*'],
    isOwner: true,
    hasPermission: () => true,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

vi.mock('@/pages/settings/components/workspace-settings', () => ({
  default: () => <div data-testid="workspace-settings">WorkspaceSettings</div>,
}));

vi.mock('@/pages/settings/components/api-keys-settings', () => ({
  default: () => <div data-testid="api-keys-settings">ApiKeysSettings</div>,
}));

vi.mock('@/pages/settings/components/preferences', () => ({
  default: () => <div data-testid="preferences">Preferences</div>,
}));

vi.mock('@/pages/settings/components/security-settings', () => ({
  default: () => <div data-testid="security-settings">SecuritySettings</div>,
}));

describe('Settings Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings page', async () => {
    renderWithProviders(<Settings />, {
      initialEntries: ['/settings/general'],
    });

    await waitFor(() => {
      expect(screen.getByText('Workspace settings')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-settings')).toBeInTheDocument();
    });
  });

  it('switches between tabs', async () => {
    vi.mocked(useParams).mockReturnValue({ tab: 'apikeys' });

    renderWithProviders(<Settings />);

    await waitFor(() => {
      expect(screen.getByText('Workspace API key')).toBeInTheDocument();
      expect(screen.getByTestId('api-keys-settings')).toBeInTheDocument();
    });
  });

  it('shows preferences tab content', async () => {
    vi.mocked(useParams).mockReturnValue({ tab: 'preferences' });

    renderWithProviders(<Settings />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Preferences' })).toBeInTheDocument();
      expect(screen.getByTestId('preferences')).toBeInTheDocument();
    });
  });

  it('offers Files only with artifact read access', () => {
    const tabsFor = (keys: string[]) =>
      filterTabGroups(settingsTabGroups, { hasPermission: (key) => keys.includes(key) })
        .flatMap((group) => group.tabs.map((tab) => tab.id));
    expect(tabsFor(['workspace.read'])).not.toContain('files');
    expect(tabsFor(['artifact.read'])).toContain('files');
  });

  it('lists owned files and storage totals, and resets pagination for the manager view', async () => {
    vi.mocked(useParams).mockReturnValue({ tab: 'files' });
    files.list.mockReturnValue({
      isFetchedAfterMount: true,
      data: {
        data: [{ id: 'file-1', name: 'scan.txt', sizeBytes: 64, source: 'agent', createdAt: '2026-01-02T00:00:00Z' }],
        hasNextPage: true,
        pageCount: 2,
      },
    });
    files.usage.mockReturnValue({
      isFetchedAfterMount: true,
      data: { usedBytes: 64, quotaBytes: 1024, reservedBytes: 0, maxFileBytes: 128 },
    });
    const { user } = renderWithProviders(<Settings />);
    expect(await screen.findByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByText('scan.txt')).toBeInTheDocument();
    expect(screen.getByText('1.0 KiB')).toBeInTheDocument();
    expect(files.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, scope: 'mine' }), expect.anything());
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(files.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, scope: 'mine' }), expect.anything());
    await user.click(screen.getByRole('button', { name: 'All files' }));
    expect(files.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, scope: 'all' }), expect.anything());
  });

  it('withholds cached peer files until the current view is authorized', async () => {
    vi.mocked(useParams).mockReturnValue({ tab: 'files' });
    files.list.mockImplementation(({ scope }: { scope: string }) => ({
      isFetchedAfterMount: scope === 'mine',
      data: { data: scope === 'mine' ? [] : [{ id: 'peer', name: 'cached-peer.txt' }] },
    }));
    files.usage.mockReturnValue({});
    const { user } = renderWithProviders(<Settings />);
    await user.click(await screen.findByRole('button', { name: 'All files' }));
    expect(screen.getByText('Loading files…')).toBeInTheDocument();
    expect(screen.queryByText('cached-peer.txt')).toBeNull();
  });

  it('filters tabs based on user role', async () => {
    vi.mocked(useParams).mockReturnValue({ tab: 'general' });
    const { useSession } = await import('@/utils/authClient');
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: 'user-1', role: 'user' } },
    } as ReturnType<typeof useSession>);

    renderWithProviders(<Settings />);

    await waitFor(() => {
      expect(screen.getByText('Workspace settings')).toBeInTheDocument();
    });
  });
});
