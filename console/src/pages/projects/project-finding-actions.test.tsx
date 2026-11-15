import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGlobalWorkspaceId,
  setGlobalWorkspaceId,
  subscribeGlobalWorkspaceId,
} from '@/utils/workspaceState';
import type { ProjectFindingDto } from '@/services/apis/gen/queries';
import { ProjectFindingActions } from './project-finding-actions';

const mock = vi.hoisted(() => ({
  dismiss: vi.fn(),
  allowed: true,
  refreshing: false,
  fresh: true,
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceSelector: () => ({
    selectedWorkspace: useSyncExternalStore(
      subscribeGlobalWorkspaceId,
      getGlobalWorkspaceId,
    ),
  }),
}));
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    hasPermission: () => mock.allowed,
    isFetching: mock.refreshing,
  }),
}));
vi.mock('@/services/apis/gen/queries', async (original) => ({
  ...(await original<typeof import('@/services/apis/gen/queries')>()),
  vulnerabilitiesControllerBulkDismissVulnerabilities: (...args: unknown[]) =>
    mock.dismiss(...args),
  useVulnerabilitiesControllerGetSettings: () => ({
    data: { riskAcceptMaxDays: 30 },
    isFetchedAfterMount: mock.fresh,
  }),
}));
vi.mock('@/pages/vulnerabilities/components/claim-fix-dialog', () => ({
  ClaimFixDialog: () => <span>Existing claim control</span>,
}));
vi.mock('@/pages/vulnerabilities/components/review-dialog', () => ({
  ReviewDialog: () => <span>Existing review control</span>,
}));
vi.mock('@/pages/vulnerabilities/components/finding-bulk-actions', () => ({
  FindingBulkActions: () => <span>Existing issue and reopen controls</span>,
}));
const finding = {
  id: 'finding-id',
  name: 'TLS fixture',
  reviewStatus: 'approved',
  detectionStatus: 'new',
  isArchived: false,
  vulnerabilityDismissal: null,
} as ProjectFindingDto;
const reload = vi.fn();
const onDone = vi.fn();
const mount = (rows = [finding]) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProjectFindingActions findings={rows} reload={reload} onDone={onDone} />
    </QueryClientProvider>,
  );
const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss alerts' }));
  return within(screen.getByRole('dialog'));
};

describe('Project finding actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.allowed = true;
    mock.refreshing = false;
    mock.fresh = true;
    setGlobalWorkspaceId('A');
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    mock.dismiss.mockResolvedValue({});
    reload.mockResolvedValue({});
  });
  it('separates proposal reviews from remediation actions', () => {
    mount([{ ...finding, reviewStatus: 'pending_review' }]);
    expect(screen.getAllByText('Existing review control')).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: 'Dismiss alerts' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Existing issue and reopen controls'),
    ).not.toBeInTheDocument();
  });
  it.each(['missing', 'refresh'])(
    'hides mutation controls during %s access',
    (state) => {
      mock.allowed = state !== 'missing';
      mock.refreshing = state === 'refresh';
      mount();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    },
  );
  it('dismisses unique finding IDs once and clears the selection after success', async () => {
    let finish!: () => void;
    mock.dismiss.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mount([finding, finding]);
    const dialog = open();
    fireEvent.change(dialog.getByLabelText('Reason'), {
      target: { value: 'wont_fix' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Saving…' }));
    await waitFor(() => expect(mock.dismiss).toHaveBeenCalledOnce());
    expect(mock.dismiss).toHaveBeenCalledWith(
      { ids: ['finding-id'], reason: 'wont_fix', comment: '' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => finish());
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });
  it('requires a fresh risk policy and a future date inside its maximum', () => {
    mock.fresh = false;
    mount();
    const dialog = open();
    fireEvent.change(dialog.getByLabelText('Reason'), {
      target: { value: 'risk_accepted' },
    });
    expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    expect(dialog.getByLabelText('Accepted until')).toBeRequired();
  });
  it('rejects offline submits and closes a draft when the workspace changes', () => {
    mount();
    const dialog = open();
    fireEvent.change(dialog.getByLabelText('Reason'), {
      target: { value: 'wont_fix' },
    });
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss' }));
    expect(mock.dismiss).not.toHaveBeenCalled();
    expect(dialog.getByRole('alert')).toHaveTextContent('Reconnect');
    act(() => setGlobalWorkspaceId('B'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('blocks replay after an uncertain outcome until saved state is checked', async () => {
    mock.dismiss.mockRejectedValue(new Error('lost response'));
    mount();
    const dialog = open();
    fireEvent.change(dialog.getByLabelText('Reason'), {
      target: { value: 'wont_fix' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeDisabled(),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Check saved state' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeEnabled(),
    );
  });
});
