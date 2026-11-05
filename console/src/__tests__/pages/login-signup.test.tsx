import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import Login from '@/pages/login/login';
import { getRootControllerGetMetadataQueryKey } from '@/services/apis/gen/queries';
import { server } from '@/test/mocks/node';
import { renderWithProviders, screen, waitFor } from '@/test/utils';

vi.mock('@/utils/authClient', () => ({
  authClient: { signIn: { email: vi.fn() } },
}));
vi.mock('@/components/common/layout/auth-layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe('Login signup discovery', () => {
  it('links to signup with the in-app destination when enabled', async () => {
    server.use(
      http.get('/api/metadata', () =>
        HttpResponse.json({ name: 'Argus', isInit: true, allowSignUp: true }),
      ),
    );
    renderWithProviders(<Login />, {
      routePath: '/login',
      initialEntries: ['/login?redirect=%2Fassets'],
    });
    const link = await screen.findByRole('link', { name: 'Sign up' });
    const target = new URL(link.getAttribute('href')!, window.location.origin);
    expect(target.pathname).toBe('/signup');
    expect(target.searchParams.get('redirect')).toBe('/assets');
  });

  it('keeps the confirmed link mounted while preloading refreshes eligibility', async () => {
    server.use(
      http.get('/api/metadata', () =>
        HttpResponse.json({ name: 'Argus', isInit: true, allowSignUp: true }),
      ),
    );
    const { queryClient } = renderWithProviders(<Login />, {
      routePath: '/login',
    });
    const link = await screen.findByRole('link', { name: 'Sign up' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/metadata', async () => {
        await gate;
        return HttpResponse.json({
          name: 'Argus',
          isInit: true,
          allowSignUp: false,
        });
      }),
    );
    const refresh = queryClient.refetchQueries({
      queryKey: getRootControllerGetMetadataQueryKey(),
    });
    try {
      await waitFor(() => expect(queryClient.isFetching()).toBe(1));
      expect(screen.getByRole('link', { name: 'Sign up' })).toBe(link);
    } finally {
      release();
      await refresh;
    }
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: 'Sign up' }),
      ).not.toBeInTheDocument(),
    );
  });

  it.each(['closed', 'failed'])(
    'refreshes cached eligibility and hides signup when %s',
    async (state) => {
      let reads = 0;
      server.use(
        http.get('/api/metadata', () => {
          reads++;
          return state === 'closed'
            ? HttpResponse.json({
                name: 'Argus',
                isInit: true,
                allowSignUp: false,
              })
            : new HttpResponse(null, { status: 503 });
        }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      queryClient.setQueryData(getRootControllerGetMetadataQueryKey(), {
        name: 'Argus',
        isInit: true,
        allowSignUp: true,
      });
      renderWithProviders(<Login />, { routePath: '/login', queryClient });
      await waitFor(() => expect(reads).toBe(1));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(
        screen.queryByRole('link', { name: 'Sign up' }),
      ).not.toBeInTheDocument();
    },
  );
});
