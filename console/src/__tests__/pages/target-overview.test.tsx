import DetailTarget from '@/pages/targets/detail-target';
import { server } from '@/test/mocks/node';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

dayjs.extend(relativeTime);

const canReadAssets = vi.hoisted(() => vi.fn(() => true));
const refetchPermissions = vi.hoisted(() => vi.fn());
const id = 'd14d1c3f-9752-4b8a-93c8-48ea3c3212ab';
const path = `/targets/${id}`;
const metrics = {
  totalAssets: 6,
  newAssets: 2,
  totalServices: 9,
  newServices: 3,
  openPorts: 0,
};

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    hasPermission: (key: string) =>
      key === 'target.read' || (key === 'asset.read' && canReadAssets()),
    isLoading: false,
    error: null,
    refetch: refetchPermissions,
  }),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'ws-1' } }),
}));
vi.mock('@/pages/assets/context/asset-context', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/pages/assets/list-assets', () => ({
  ListAssets: () => <p>Asset inventory</p>,
}));

function show(tab = 'overview') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute();
  const authed = createRoute({ getParentRoute: () => root, id: '_authed' });
  const detail = createRoute({
    getParentRoute: () => authed,
    path: '/targets/$id/$tab',
    component: DetailTarget,
  });
  const router = createRouter({
    routeTree: root.addChildren([authed.addChildren([detail])]),
    history: createMemoryHistory({ initialEntries: [`${path}/${tab}`] }),
    defaultPendingMinMs: 0,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), router };
}

describe('Target Overview tab', () => {
  beforeEach(() => {
    canReadAssets.mockReturnValue(true);
    refetchPermissions.mockClear();
    server.use(
      http.get(`/api${path}`, () =>
        HttpResponse.json({
          id,
          type: 'DOMAIN',
          value: 'overview.example.test',
          status: 'completed',
          lastDiscoveredAt: '2026-01-01T00:00:00Z',
        }),
      ),
      http.get(`/api${path}/overview`, () => HttpResponse.json(metrics)),
    );
  });

  it('opens from Assets and displays totals, recent discoveries, and zero values', async () => {
    const { user, router } = show('assets');
    expect(await screen.findByText('Asset inventory')).toBeVisible();
    const overviewLink = screen.getByRole('link', { name: 'Overview' });
    await user.click(overviewLink);
    const overview = within(
      await screen.findByRole('region', { name: 'Target overview' }),
    );
    expect(await overview.findByText('Enabled assets')).toBeVisible();
    expect(overview.getByText('Discovered services')).toBeVisible();
    expect(overview.getByText('Open ports')).toBeVisible();
    expect(overview.getByText('0', { exact: true })).toBeVisible();
    expect(overview.getByText('2 new in the last 7 days')).toBeVisible();
    expect(overview.getByText('3 new in the last 7 days')).toBeVisible();
    expect(router.state.location.pathname).toBe(`${path}/overview`);
    expect(overviewLink).toHaveAttribute('aria-current', 'page');
  });

  it('hides the link and skips the request on a restricted deep link', async () => {
    canReadAssets.mockReturnValue(false);
    const getOverview = vi.fn(() => HttpResponse.json(metrics));
    server.use(http.get(`/api${path}/overview`, getOverview));
    show();
    expect(
      await screen.findByText(/don.t have permission to access this page/),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Overview' }),
    ).not.toBeInTheDocument();
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus on retry until a fresh response arrives', async () => {
    server.use(
      http.get(
        `/api${path}/overview`,
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    const { user } = show();
    const retry = await screen.findByRole('button', { name: 'Retry overview' });
    server.use(
      http.get(`/api${path}/overview`, async () => {
        await delay(150);
        return HttpResponse.json(metrics);
      }),
    );
    await user.click(retry);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('Enabled assets')).toBeVisible();
  });

  it('rechecks permissions without showing cached counts when the API denies access', async () => {
    const { user } = show();
    expect(await screen.findByText('Enabled assets')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Assets', exact: true }));
    expect(await screen.findByText('Asset inventory')).toBeVisible();
    server.use(
      http.get(`/api${path}/overview`, async () => {
        await delay(150);
        return new HttpResponse(null, { status: 403 });
      }),
    );
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    expect(screen.queryByText('Enabled assets')).not.toBeInTheDocument();
    expect(
      await screen.findByText(/don.t have permission to access this page/),
    ).toBeVisible();
    expect(refetchPermissions).toHaveBeenCalledTimes(1);
  });
});
