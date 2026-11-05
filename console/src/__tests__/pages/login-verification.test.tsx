import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import Login from '@/pages/login/login';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  resend: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/utils/authClient', () => ({
  authClient: {
    signIn: { email: mocks.signIn },
    sendVerificationEmail: mocks.resend,
  },
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock('@/components/common/layout/auth-layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
const resendName = 'Send the verification email again';

/** Render the public login route with its real search values. */
async function openLogin(search = '') {
  renderWithProviders(<Login />, {
    routePath: '/login',
    initialEntries: ['/login' + search],
  });
  await screen.findByLabelText('Email');
  return userEvent.setup();
}

/** Submit credentials that the server identifies as unverified. */
async function submitUnverified(search = '') {
  const user = await openLogin(search);
  await user.type(screen.getByLabelText('Email'), 'pending@example.com');
  await user.type(screen.getByLabelText('Password'), 'Password123!');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('button', { name: resendName });
  return user;
}

describe('Login email verification', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.signIn.mockResolvedValue({
      error: {
        code: 'EMAIL_NOT_VERIFIED',
        status: 403,
        message: 'Email not verified',
      },
    });
    mocks.resend.mockResolvedValue({ data: { status: true } });
  });

  it('explains email confirmation without claiming account approval', async () => {
    // Match the login route's z.coerce.string() output in the test router.
    await openLogin('?verified=%221%22');
    expect(screen.getByRole('alert')).toHaveTextContent('Email confirmed');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'once an administrator approves',
    );
    expect(mocks.resend).not.toHaveBeenCalled();
  });

  it('prioritizes an invalid link over a confirmation marker', async () => {
    await openLogin('?verified=1&error=INVALID_TOKEN');
    expect(screen.getByRole('alert')).toHaveTextContent(
      "The verification link didn't work",
    );
    expect(screen.queryByText('Email confirmed')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('INVALID_TOKEN');
  });

  it('does not treat a false confirmation marker as success', async () => {
    await openLogin('?verified=0');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers resend only after an unverified credential response', async () => {
    await openLogin();
    expect(
      screen.queryByRole('button', { name: resendName }),
    ).not.toBeInTheDocument();
    expect(mocks.resend).not.toHaveBeenCalled();
  });

  it.each(['INVALID_EMAIL_OR_PASSWORD', 'BANNED_USER'])(
    'does not offer resend for %s',
    async (code) => {
      mocks.signIn.mockResolvedValue({
        error: { code, status: 403, message: 'Sign-in denied' },
      });
      const user = await openLogin();
      await user.type(screen.getByLabelText('Email'), 'pending@example.com');
      await user.type(screen.getByLabelText('Password'), 'Password123!');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByText('Sign-in denied');
      expect(
        screen.queryByRole('button', { name: resendName }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    '/assets?view=all#results',
    'https://outside.example/',
    '//outside.example/',
    '/\\outside.example/',
  ])('resends with a same-origin callback for %s', async (redirect) => {
    const user = await submitUnverified(
      '?redirect=' + encodeURIComponent(redirect),
    );
    await user.click(screen.getByRole('button', { name: resendName }));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith('Verification email sent', {
        description: 'Check pending@example.com for the link.',
      }),
    );
    const payload = mocks.resend.mock.calls[0][0];
    expect(payload.email).toBe('pending@example.com');
    const callback = new URL(payload.callbackURL);
    expect(callback.origin).toBe(window.location.origin);
    expect(callback.pathname).toBe('/login');
    expect(callback.searchParams.get('verified')).toBe('1');
    expect(callback.searchParams.get('redirect')).toBe(
      redirect.startsWith('/assets') ? redirect : '/',
    );
  });

  it('prevents duplicate resends and concurrent sign-in, then permits retry', async () => {
    let finish!: (value: unknown) => void;
    mocks.resend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = await submitUnverified();
    const resend = screen.getByRole('button', { name: resendName });
    await resend.focus();
    await user.keyboard('{Enter}');
    expect(resend).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await user.click(resend);
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    finish({ error: { message: 'Try again later' } });
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('Try again later', {
        richColors: true,
      }),
    );
    expect(resend).toBeEnabled();
    await user.click(resend);
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
  });

  it('restores controls after a resend network failure', async () => {
    mocks.resend.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = await submitUnverified();
    await user.click(screen.getByRole('button', { name: resendName }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        'Failed to send the verification email.',
        { richColors: true },
      ),
    );
    expect(screen.getByRole('button', { name: resendName })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('clears the previous resend target after another login attempt fails', async () => {
    const user = await submitUnverified();
    mocks.signIn.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'different@example.com');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: resendName }),
    ).not.toBeInTheDocument();
  });
});
