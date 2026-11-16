import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGlobalWorkspaceId,
  setGlobalWorkspaceId,
  subscribeGlobalWorkspaceId,
} from '@/utils/workspaceState';
import type { VulnerabilityLifecycleDto } from '@/services/apis/gen/queries';
import { ListVulnerabilities } from './list-vulnerabilitys';

const state = vi.hoisted(() => ({
  rows: [] as VulnerabilityLifecycleDto[],
  permissions: new Set<string>(),
  fetching: false,
  reopen: vi.fn(),
  create: vi.fn(),
  reload: vi.fn(),
  navigate: vi.fn(),
  success: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: state.success, error: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
  useSearch: () => ({}),
}));
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    hasPermission: (key: string) => state.permissions.has(key),
    isLoading: false,
    isFetching: state.fetching,
    error: null,
  }),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceSelector: () => ({
    selectedWorkspace: useSyncExternalStore(
      subscribeGlobalWorkspaceId,
      getGlobalWorkspaceId,
    ),
    workspaces: [{ id: 'A' }],
  }),
  useWorkspaceState: () => ({
    state: {
      selectedWorkspaceId: useSyncExternalStore(
        subscribeGlobalWorkspaceId,
        getGlobalWorkspaceId,
      ),
    },
  }),
}));
vi.mock('@/services/apis/gen/queries', async (original) => ({
  ...(await original<typeof import('@/services/apis/gen/queries')>()),
  useVulnerabilitiesControllerGetVulnerabilities: () => ({
    data: { data: state.rows, total: state.rows.length },
    isLoading: false,
    refetch: state.reload,
  }),
  vulnerabilitiesControllerBulkReopenVulnerabilities: (...args: unknown[]) =>
    state.reopen(...args),
  issuesControllerCreate: (...args: unknown[]) => state.create(...args),
  issuesControllerGetMany: vi.fn().mockResolvedValue({ data: [] }),
  issueRulesControllerListRules: vi.fn().mockResolvedValue([]),
  useWorkspacesControllerGetWorkspaceMembers: () => ({
    data: [],
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useServerDataTable', () => ({
  useServerDataTable: () => ({
    tableParams: {
      page: 1,
      pageSize: 10,
      sortBy: 'severity',
      sortOrder: 'DESC',
    },
    tableHandlers: {
      setPage: vi.fn(),
      setPageSize: vi.fn(),
      setFilter: vi.fn(),
      setParams: vi.fn(),
    },
  }),
}));
vi.mock('@/components/ui/data-table', () => ({
  DataTable: ({
    data,
    rowSelection,
    onRowSelectionChange,
    selectionHeader,
  }: {
    data: { id: string }[];
    rowSelection: Record<string, boolean>;
    onRowSelectionChange: (next: Record<string, boolean>) => void;
    selectionHeader: (count: number) => React.ReactNode;
  }) => (
    <>
      <button
        onClick={() =>
          onRowSelectionChange(
            Object.fromEntries(data.map((row) => [row.id, true])),
          )
        }
      >
        Select visible
      </button>
      {Object.keys(rowSelection).length > 0 &&
        selectionHeader(Object.keys(rowSelection).length)}
    </>
  ),
}));
vi.mock('./vulnerablity-columns', () => ({ vulnerabilityColumns: [] }));
vi.mock('@/components/filter-builder/filter-toolbar', () => ({
  FilterToolbar: () => null,
}));
vi.mock('@/components/ui/date-picker-range', () => ({
  DatePickerWithRange: () => null,
}));
vi.mock('./components/status-filter', () => ({ StatusFilter: () => null }));
vi.mock('./components/review-dialog', () => ({
  ReviewDialog: () => <span>Existing review</span>,
}));
vi.mock('./components/claim-fix-dialog', () => ({
  ClaimFixDialog: () => <span>Existing fix claim</span>,
}));
vi.mock('./components/dismiss-dialog', () => ({
  DismissAlertDialog: () => <span>Existing dismissal</span>,
}));

const finding = (id: string, overrides = {}) =>
  ({
    id,
    name: 'Finding ' + id,
    reviewStatus: 'approved',
    detectionStatus: 'active',
    ...overrides,
  }) as VulnerabilityLifecycleDto;
const dismissed = (id: string) =>
  finding(id, {
    vulnerabilityDismissal: { id: 'dismissal-' + id, reason: 'false_positive' },
  });
let client: QueryClient;
const mount = () => {
  const tree = () => (
    <QueryClientProvider client={client}>
      <ListVulnerabilities />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()) };
};
const select = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Select visible' }));
const openIssue = () => {
  select();
  fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
  return within(screen.getByRole('dialog'));
};

describe('Shared finding-list bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setGlobalWorkspaceId('A');
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    state.permissions = new Set([
      'workspace.read',
      'workspace.write',
      'vulnerability.read',
      'vulnerability.write',
    ]);
    state.fetching = false;
    state.rows = [dismissed('one'), dismissed('two'), finding('open')];
    state.reopen.mockResolvedValue({ reopened: 2 });
    state.create.mockResolvedValue({ id: 'issue', no: 42 });
    state.reload.mockResolvedValue({ isError: false });
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  it('reopens only selected dismissed findings once and clears selection after success', async () => {
    let finish!: (value: unknown) => void;
    state.reopen.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    select();
    const button = screen.getByRole('button', { name: 'Reopen' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(state.reopen).toHaveBeenCalledTimes(1));
    expect(state.reopen).toHaveBeenCalledWith(
      { ids: ['dismissal-one', 'dismissal-two'] },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeout: 20000,
      }),
    );
    await act(async () => finish({ reopened: 2 }));
    await waitFor(() => expect(screen.queryByText('3 selected')).toBeNull());
  });

  it('creates one remediation issue linked to every selected approved finding', async () => {
    state.rows = [finding('one'), finding('two', { detectionStatus: 'fixed' })];
    mount();
    const dialog = openIssue();
    expect(
      dialog.getByText(
        '2 selected findings will be linked to this remediation issue.',
      ),
    ).toBeVisible();
    fireEvent.change(dialog.getByLabelText('Title'), {
      target: { value: 'Remediate selected findings' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Create issue' }));
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Remediate selected findings',
          type: 'vulnerability_remediation',
          links: [
            { resourceType: 'vulnerability', resourceId: 'one' },
            { resourceType: 'vulnerability', resourceId: 'two' },
          ],
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: '/issues/$id',
        params: { id: 'issue' },
      }),
    );
  });

  it('keeps issue and finding write permissions independent', () => {
    state.permissions.delete('vulnerability.write');
    const view = mount();
    select();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create issue' })).toBeVisible();
    state.permissions.add('vulnerability.write');
    state.permissions.delete('workspace.write');
    view.refresh();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create issue' })).toBeNull();
  });

  it('does not offer the new actions for proposals or a selection without writes', () => {
    state.rows = [finding('proposal', { reviewStatus: 'pending_review' })];
    const view = mount();
    select();
    expect(screen.queryByRole('button', { name: 'Create issue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    state.rows = [dismissed('one')];
    state.permissions = new Set(['vulnerability.read']);
    view.refresh();
    select();
    expect(screen.queryByRole('button', { name: 'Create issue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('keeps existing fix-claim and dismissal controls for open findings', () => {
    state.rows = [finding('open')];
    mount();
    select();
    expect(screen.getByText('Existing fix claim')).toBeVisible();
    expect(screen.getByText('Existing dismissal')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('refuses offline Reopen and does not queue it for reconnect', async () => {
    mount();
    select();
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnect');
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    await act(async () => {});
    expect(state.reopen).not.toHaveBeenCalled();
  });

  it('blocks unknown Reopen outcomes across remounts until saved state is checked', async () => {
    state.reopen.mockRejectedValue(new AxiosError('Response lost'));
    const view = mount();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Outcome unknown',
    );
    view.unmount();
    mount();
    select();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check saved state' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reopen' })).not.toBeDisabled(),
    );
    expect(state.reopen).toHaveBeenCalledTimes(1);
  });

  it('aborts Reopen and drops success effects across A to B to A', async () => {
    let finish!: (value: unknown) => void;
    state.reopen.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(state.reopen).toHaveBeenCalledOnce());
    const request = state.reopen.mock.calls[0][1] as { signal: AbortSignal };
    act(() => setGlobalWorkspaceId('B'));
    act(() => setGlobalWorkspaceId('A'));
    expect(request.signal.aborted).toBe(true);
    await act(async () => finish({ reopened: 2 }));
    expect(state.success).not.toHaveBeenCalled();
  });

  it('closes an issue draft when visible selection or workspace changes', () => {
    const view = mount();
    openIssue();
    state.rows = [finding('new')];
    view.refresh();
    expect(screen.queryByRole('dialog')).toBeNull();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    act(() => setGlobalWorkspaceId('B'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('disables new submissions during permission refresh and closes on revocation', () => {
    const view = mount();
    select();
    state.fetching = true;
    view.refresh();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create issue' })).toBeDisabled();
    state.fetching = false;
    view.refresh();
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    state.permissions.delete('workspace.write');
    view.refresh();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('serializes issue creation and aborts stale navigation on workspace change', async () => {
    let finish!: (value: unknown) => void;
    state.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    const dialog = openIssue();
    const submit = dialog.getByRole('button', { name: 'Create issue' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
    const request = state.create.mock.calls[0][1] as { signal: AbortSignal };
    act(() => setGlobalWorkspaceId('B'));
    expect(request.signal.aborted).toBe(true);
    await act(async () => finish({ id: 'old-issue', no: 42 }));
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });

  it('never queues issue creation while offline', async () => {
    mount();
    const dialog = openIssue();
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Create issue' }));
    await waitFor(() =>
      expect(
        dialog.getByRole('button', { name: 'Create issue' }),
      ).not.toBeDisabled(),
    );
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    await act(async () => {});
    expect(state.create).not.toHaveBeenCalled();
  });

  it('keeps issue saved-state recovery available after closing an uncertain draft', async () => {
    state.create.mockRejectedValue(new Error('Response lost'));
    mount();
    const dialog = openIssue();
    fireEvent.click(dialog.getByRole('button', { name: 'Create issue' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Outcome unknown',
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check saved issues' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Discard uncertain submission',
      }),
    );
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('clears selection even when a successful refresh removes every dismissed row', async () => {
    state.rows = [dismissed('one')];
    const view = mount();
    vi.spyOn(client, 'invalidateQueries').mockImplementation(async () => {
      state.rows = [];
      view.refresh();
    });
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(state.reopen).toHaveBeenCalledOnce());
    await act(async () => {});
    state.rows = [dismissed('one')];
    view.refresh();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(state.success).toHaveBeenCalledOnce();
  });

  it('clears checked uncertainty when the saved-state reload unmounts the toolbar', async () => {
    state.reopen.mockRejectedValue(new AxiosError('Response lost'));
    const view = mount();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await screen.findByRole('alert');
    state.reload.mockImplementation(async () => {
      state.rows = [];
      view.refresh();
      return { isError: false };
    });
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Check saved state' }),
      ),
    );
    state.rows = [dismissed('three')];
    view.refresh();
    select();
    expect(screen.getByRole('button', { name: 'Reopen' })).not.toBeDisabled();
  });
});
