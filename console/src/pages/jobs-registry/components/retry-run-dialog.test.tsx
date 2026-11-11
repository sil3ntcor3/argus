import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryRunDialog } from './retry-run-dialog';

const mock = vi.hoisted(() => ({
  retry: vi.fn(),
  navigate: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  jobsRegistryControllerRetryJobHistory: mock.retry,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mock.navigate,
  Link: ({ children }: { children: string }) => <a href="/jobs">{children}</a>,
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: mock.workspace,
}));

function openDialog() {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <RetryRunDialog runId="original" workspaceId="fixture" />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'Retry run' });
  fireEvent.click(trigger);
  const dialog = within(
    screen.getByRole('dialog', { name: 'Retry this run?' }),
  );
  return {
    ...view,
    dialog,
    trigger,
    confirm: dialog.getByRole('button', { name: 'Start retry' }),
  };
}

describe('RetryRunDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workspace.mockReturnValue('fixture');
    mock.retry.mockResolvedValue({ jobHistoryId: 'fresh' });
  });

  it('starts one new run only after confirmation and navigates to it', async () => {
    const { confirm, dialog } = openDialog();
    expect(dialog.getByText(/original scope/)).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Keep run' })).toHaveFocus();
    expect(mock.retry).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mock.navigate).toHaveBeenCalledWith({
        to: '/jobs/runs/$id',
        params: { id: 'fresh' },
      }),
    );
    expect(mock.retry).toHaveBeenCalledExactlyOnceWith(
      'original',
      expect.any(Object),
    );
  });

  it('keeps the original run open and shows a recoverable rejection', async () => {
    const error = new AxiosError();
    error.status = 400;
    mock.retry.mockRejectedValueOnce(error);
    const { confirm, dialog, trigger } = openDialog();
    fireEvent.click(confirm);
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'This run could not be retried',
    );
    expect(dialog.queryByRole('button', { name: 'Start retry' })).toBeNull();
    const close = dialog.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.navigate).not.toHaveBeenCalled();
  });

  it('offers the runs list for an uncertain request without resubmitting', async () => {
    mock.retry.mockRejectedValueOnce(new Error('Connection lost'));
    const { confirm, dialog } = openDialog();
    fireEvent.click(confirm);
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Could not confirm the retry started',
    );
    expect(dialog.getByRole('link', { name: 'View runs' })).toBeVisible();
    expect(dialog.queryByRole('button', { name: 'Start retry' })).toBeNull();
    expect(mock.retry).toHaveBeenCalledTimes(1);
  });

  it('does not send the retry when the workspace changes before confirmation', () => {
    const { confirm, dialog } = openDialog();
    mock.workspace.mockReturnValue('different');
    fireEvent.click(confirm);
    expect(dialog.getByRole('alert')).toHaveTextContent(
      'The selected workspace changed',
    );
    expect(mock.retry).not.toHaveBeenCalled();
  });

  it('does not navigate away after leaving the run during a retry', async () => {
    let finish!: (result: { jobHistoryId: string }) => void;
    mock.retry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { confirm, unmount } = openDialog();
    fireEvent.click(confirm);
    await waitFor(() => expect(mock.retry).toHaveBeenCalledTimes(1));
    unmount();
    finish({ jobHistoryId: 'fresh' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.navigate).not.toHaveBeenCalled();
  });
});
