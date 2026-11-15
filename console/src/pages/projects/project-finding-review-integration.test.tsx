import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGlobalWorkspaceId,
  setGlobalWorkspaceId,
  subscribeGlobalWorkspaceId,
} from '@/utils/workspaceState';
import type { ProjectFindingDto } from '@/services/apis/gen/queries';
import { ProjectFindingsPage } from './project-findings-page';

const mock = vi.hoisted(() => ({
  rows: [] as ProjectFindingDto[],
  approve: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({
    state: {
      selectedWorkspaceId: useSyncExternalStore(
        subscribeGlobalWorkspaceId,
        getGlobalWorkspaceId,
      ),
    },
  }),
  useWorkspaceSelector: () => ({
    selectedWorkspace: useSyncExternalStore(
      subscribeGlobalWorkspaceId,
      getGlobalWorkspaceId,
    ),
  }),
}));
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ hasPermission: () => true }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('sonner', () => ({ toast: { success: mock.toast } }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock('@/services/apis/gen/queries', async (original) => ({
  ...(await original<typeof import('@/services/apis/gen/queries')>()),
  useProjectsControllerGetFindings: () =>
    useQuery({
      queryKey: ['/api/projects/fixture/vulnerabilities'],
      retry: false,
      queryFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { data: mock.rows, hasNextPage: false, pageCount: 1 };
      },
    }),
  useProjectsControllerGetById: () => ({
    data: { archivedAt: null, assetGroupWorkflows: [] },
  }),
  useProjectsControllerGetFindingStatistics: () => ({
    data: {
      data: [],
      byDetectionStatus: { new: 0, active: 0, resurfaced: 0, fixed: 0 },
      mttr: [],
      pendingReview: 1,
    },
  }),
  vulnerabilitiesControllerApprove: (...args: unknown[]) =>
    mock.approve(...args),
}));
const first = {
  id: 'first',
  name: 'First proposal',
  assetValue: 'argus.example.test',
  severity: 'high',
  reviewStatus: 'pending_review',
  status: 'open',
  provenance: 'new',
  timesSeen: 1,
  firstSeen: { at: '2026-01-01' },
  lastSeen: { at: '2026-01-01' },
} as ProjectFindingDto;
const second = { ...first, id: 'second', name: 'Second proposal' };
const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const select = async (name: string) => {
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', {
        name: `Select ${name} on argus.example.test`,
      }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: `Select ${name} on argus.example.test`,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Approve proposals' }));
  return within(screen.getByRole('dialog'));
};

describe('Project list with real proposal review dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setGlobalWorkspaceId('A');
    mock.rows = [first];
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });
  const mount = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ProjectFindingsPage
          projectId={projectId}
          page={1}
          status="pending_review"
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    return client;
  };
  it('acknowledges approval before refreshed filters remove the selected proposal', async () => {
    mock.approve.mockImplementation(async () => {
      mock.rows = [];
      return {};
    });
    mount();
    const dialog = await select(first.name);
    fireEvent.click(dialog.getByRole('button', { name: 'Approve proposal' }));
    await screen.findByText('No findings found');
    expect(mock.approve).toHaveBeenCalledOnce();
    expect(mock.toast).toHaveBeenCalledWith('Proposal approved.');
  });
  it('can explicitly discard an uncertain attempt after refresh unmounts its dialog', async () => {
    mock.approve.mockImplementation(async () => {
      mock.rows = [];
      throw new Error('Lost saved response');
    });
    const client = mount();
    let dialog = await select(first.name);
    fireEvent.click(dialog.getByRole('button', { name: 'Approve proposal' }));
    await dialog.findByRole('alert');
    fireEvent.click(dialog.getByRole('button', { name: 'Check saved state' }));
    await screen.findByText('No findings found');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mock.rows = [second];
    await act(async () => {
      await client.invalidateQueries();
    });
    dialog = await select(second.name);
    expect(
      dialog.getByRole('button', { name: 'Approve proposal' }),
    ).toBeDisabled();
    fireEvent.click(
      dialog.getByRole('button', { name: 'Discard local attempt' }),
    );
    await waitFor(() =>
      expect(
        dialog.getByRole('button', { name: 'Approve proposal' }),
      ).toBeEnabled(),
    );
    expect(mock.approve).toHaveBeenCalledOnce();
  });
});
