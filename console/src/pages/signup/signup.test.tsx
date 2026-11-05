import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { fireEvent } from '@testing-library/react';
import {
  getRootControllerGetMetadataQueryKey,
  getRootControllerGetMetadataQueryOptions,
} from '@/services/apis/gen/queries';
import { server } from '@/test/mocks/node';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import SignUp from './signup';

const mocks = vi.hoisted(() => ({
  signup: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/utils/authClient', () => ({
  authClient: { signUp: { email: mocks.signup } },
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock('@/components/common/layout/auth-layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

/** Serve real metadata queries so loading, cache and error transitions are tested. */
function metadata(allowSignUp = true) {
  server.use(
    http.get('/api/metadata', () =>
      HttpResponse.json({ name: 'Argus', isInit: true, allowSignUp }),
    ),
  );
}

/** Render signup, retaining the real router search object. */
function setup(search = '', queryClient?: QueryClient) {
  return renderWithProviders(<SignUp />, {
    routePath: '/signup',
    initialEntries: ['/signup' + search],
    queryClient,
  });
}

/** Fill fields without slowing long-password cases with character-by-character input. */
async function fill(values: Record<string, string> = {}) {
  await screen.findByLabelText('Name');
  for (const [label, value] of Object.entries({
    Name: '  Ada  ',
    Email: 'ada@example.com',
    Password: 'Password123!',
    'Confirm password': 'Password123!',
    ...values,
  })) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

describe('Public signup', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.signup.mockResolvedValue({ data: { token: null }, error: null });
    metadata();
  });

  it('creates a pending account and returns to login with its destination', async () => {
    const { user, router } = setup('?redirect=%2Fassets');
    await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toMatchObject({ redirect: '/assets' });
    expect(mocks.signup).toHaveBeenCalledWith({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'Password123!',
      callbackURL:
        window.location.origin + '/login?verified=1&redirect=%2Fassets',
    });
    expect(mocks.success).toHaveBeenCalledWith('Account created', {
      description: expect.stringMatching(/confirm your email.*administrator/i),
    });
  });

  it.each([
    ['Name', ' ', 'Name is required'],
    ['Name', 'a'.repeat(101), 'Name too long'],
    ['Email', 'invalid', 'Invalid email address'],
    ['Password', 'short', 'Password must be at least 8 characters'],
    ['Password', 'a'.repeat(129), 'Password must be at most 128 characters'],
    ['Confirm password', 'different', 'Passwords do not match.'],
  ])('validates %s before sending', async (label, value, error) => {
    const { user } = setup();
    await fill({ [label]: value });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(error)).toBeInTheDocument();
    expect(mocks.signup).not.toHaveBeenCalled();
  });

  it('blocks repeated submission while registration is pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.signup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = setup();
    await fill();
    const button = screen.getByRole('button', { name: 'Create account' });
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(mocks.signup).toHaveBeenCalledTimes(1);
    finish({ error: { status: 500, message: 'Try again later' } });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('retains the draft and pending-submit guard across an eligibility refresh', async () => {
    let finish!: (value: unknown) => void;
    let release!: () => void;
    mocks.signup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user, queryClient } = setup();
    await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/metadata', async () => {
        await gate;
        return HttpResponse.json({
          name: 'Argus',
          isInit: true,
          allowSignUp: true,
        });
      }),
    );
    const refresh = queryClient.refetchQueries({
      queryKey: getRootControllerGetMetadataQueryKey(),
    });
    try {
      await screen.findByLabelText('Loading signup availability');
    } finally {
      release();
      await refresh;
    }
    expect(await screen.findByLabelText('Name')).toHaveValue('  Ada  ');
    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).toBeDisabled();
    expect(mocks.signup).toHaveBeenCalledTimes(1);
    finish({ error: { status: 500, message: 'Try again later' } });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toBeEnabled(),
    );
  });

  it.each(['server', 'network'])(
    'allows retry after a %s failure',
    async (failure) => {
      if (failure === 'server')
        mocks.signup.mockResolvedValueOnce({
          error: { status: 500, message: 'Try again later' },
        });
      else mocks.signup.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { user } = setup();
      await fill();
      await user.click(screen.getByRole('button', { name: 'Create account' }));
      await waitFor(() => expect(mocks.error).toHaveBeenCalled());
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toBeEnabled();
      await user.click(screen.getByRole('button', { name: 'Create account' }));
      await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    },
  );

  it('replaces the form when the API reports signup closed after page load', async () => {
    mocks.signup.mockImplementationOnce(() => {
      metadata(false);
      return Promise.resolve({
        error: { status: 403, message: 'Sign-up is disabled' },
      });
    });
    const { user } = setup();
    await fill();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign-up is turned off' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('shows loading and no form while metadata is pending', async () => {
    server.use(http.get('/api/metadata', () => new Promise(() => {})));
    setup();
    expect(
      await screen.findByLabelText('Loading signup availability'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('shows a closed notice with a return-to-login link', async () => {
    metadata(false);
    setup('?redirect=%2Fassets');
    expect(
      await screen.findByRole('heading', { name: 'Sign-up is turned off' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to sign in' }),
    ).toHaveAttribute('href', '/login?redirect=%2Fassets');
  });

  it('keeps cached-open eligibility closed after a failed metadata read', async () => {
    server.use(
      http.get('/api/metadata', () => new HttpResponse(null, { status: 503 })),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(getRootControllerGetMetadataQueryKey(), {
      name: 'Argus',
      isInit: true,
      allowSignUp: true,
    });
    await queryClient
      .fetchQuery(
        getRootControllerGetMetadataQueryOptions({
          query: { staleTime: 0, retry: false },
        }),
      )
      .catch(() => null);
    setup('', queryClient);
    expect(
      await screen.findByRole('heading', { name: 'Sign-up is unavailable' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(mocks.signup).not.toHaveBeenCalled();
  });

  it('sanitizes an external destination on both registration and login links', async () => {
    const { user, router } = setup('?redirect=https%3A%2F%2Foutside.example');
    await fill();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?redirect=%2F',
    );
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toMatchObject({ redirect: '/' });
    expect(
      new URL(mocks.signup.mock.calls[0][0].callbackURL).searchParams.get(
        'redirect',
      ),
    ).toBe('/');
  });
});
