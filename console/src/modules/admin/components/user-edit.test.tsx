import type { AdminUserDto } from '@/services/apis/gen/queries';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserEdit } from './user-edit';
import { UserInfo } from './user-info';

const { unbanUser, settings, success, error } = vi.hoisted(() => ({
  unbanUser: vi.fn(),
  settings: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/utils/authClient', () => ({
  authClient: { admin: { unbanUser } },
  useSession: () => ({ data: { user: { id: 'admin' } } }),
}));
vi.mock('sonner', () => ({ toast: { success, error } }));
vi.mock('@/services/apis/gen/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/apis/gen/queries')>()),
  useSystemConfigsControllerGetSettings: settings,
}));
const user = (overrides: Partial<AdminUserDto> = {}): AdminUserDto => ({
  id: '30f77caf-42a7-46cb-a871-5de7d0a70bc8',
  name: 'Ada',
  email: 'ada@example.com',
  emailVerified: false,
  role: 'user',
  banned: true,
  banReason: 'Pending approval',
  banExpires: null,
  createdAt: '2026-10-30T00:00:00Z',
  updatedAt: '2026-10-30T00:00:00Z',
  lastActiveAt: null,
  ...overrides,
});
const withMail = (enabled: boolean) =>
  settings.mockReturnValue({
    data: { mailServer: { enabled } },
    isLoading: false,
    isError: false,
  });

describe('pending account approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withMail(false);
    unbanUser.mockResolvedValue({ error: null });
  });
  it('offers approval instead of ordinary ban controls', async () => {
    renderWithProviders(<UserEdit user={user()} />);
    expect(await screen.findByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Unban user' }),
    ).not.toBeInTheDocument();
  });
  it('blocks unverified approval while mail is enabled', async () => {
    withMail(true);
    renderWithProviders(<UserEdit user={user()} />);
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/haven't confirmed their email yet/),
    ).toBeInTheDocument();
  });
  it('allows a verified account while mail is enabled', async () => {
    withMail(true);
    renderWithProviders(<UserEdit user={user({ emailVerified: true })} />);
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeEnabled();
  });
  it('blocks unverified approval while settings are loading', async () => {
    settings.mockReturnValue({ isLoading: true, isError: false });
    renderWithProviders(<UserEdit user={user()} />);
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading approval settings',
    );
  });
  it('blocks unavailable settings and offers Retry', async () => {
    const refetch = vi.fn();
    settings.mockReturnValue({ isLoading: false, isError: true, refetch });
    const { user: actor } = renderWithProviders(<UserEdit user={user()} />);
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeDisabled();
    await actor.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(unbanUser).not.toHaveBeenCalled();
  });
  it('unbans once, disables while saving, and refreshes both user views', async () => {
    let resolve!: (value: { error: null }) => void;
    unbanUser.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { user: actor, queryClient } = renderWithProviders(
      <UserEdit user={user()} />,
    );
    const refresh = vi.spyOn(queryClient, 'invalidateQueries');
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await actor.click(approve);
    expect(approve).toBeDisabled();
    expect(unbanUser).toHaveBeenCalledExactlyOnceWith({ userId: user().id });
    resolve({ error: null });
    await waitFor(() => expect(success).toHaveBeenCalledWith('User approved.'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('shows a failed approval once and permits retry', async () => {
    unbanUser.mockResolvedValue({ error: { message: 'Approval refused' } });
    const { user: actor } = renderWithProviders(<UserEdit user={user()} />);
    await actor.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledExactlyOnceWith('Approval refused'),
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(success).not.toHaveBeenCalled();
  });
  it.each([{ banned: false }, { banReason: 'Spam' }])(
    'retains ordinary ban controls for %j',
    async (overrides) => {
      renderWithProviders(<UserEdit user={user(overrides)} />);
      expect(
        await screen.findByRole('button', {
          name: overrides.banned === false ? 'Ban user' : 'Unban user',
        }),
      ).toBeEnabled();
      expect(
        screen.queryByText('Waiting for approval'),
      ).not.toBeInTheDocument();
    },
  );
  it('does not let an administrator approve their own pending account', async () => {
    renderWithProviders(<UserEdit user={user({ id: 'admin' })} />);
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeDisabled();
  });
  it('does not describe pending signup as an ordinary ban in account details', async () => {
    renderWithProviders(<UserInfo user={user()} />);
    expect(await screen.findByText(user().email)).toBeInTheDocument();
    expect(screen.queryByText('Ban reason')).not.toBeInTheDocument();
    expect(screen.queryByText('Ban expires')).not.toBeInTheDocument();
  });
});
