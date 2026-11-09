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
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

dayjs.extend(relativeTime);

const canReadAssets = vi.hoisted(() => vi.fn(() => true));
const canReadJobs = vi.hoisted(() => vi.fn(() => true));
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
      key === 'target.read' ||
      (key === 'asset.read' && canReadAssets()) ||
      (key === 'job.read' && canReadJobs()),
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

beforeEach(() => {
  canReadAssets.mockReturnValue(true);
  canReadJobs.mockReturnValue(true);
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

describe('Target Overview tab', () => {
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

describe('Target Activity tab', () => {
  const firstRun = {
    id: 'run-1',
    workflowName: 'Network discovery',
    status: 'in_progress',
    jobRunType: 'manual',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    jobsTotal: 2,
    jobsDone: 1,
    jobsFailed: 0,
    jobsRunning: 1,
  };
  const runsPath = `/api${path}/runs`;
  const pageOne = {
    data: [firstRun],
    page: 1,
    limit: 10,
    total: 2,
    hasNextPage: true,
    pageCount: 2,
  };

  it('appends pages, keeps existing runs on a later-page failure, and links to run details', async () => {
    let failMore = true;
    server.use(
      http.get(runsPath, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page');
        if (page === '1') return HttpResponse.json(pageOne);
        if (failMore) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({
          ...pageOne,
          page: 2,
          hasNextPage: false,
          data: [{ ...firstRun, id: 'run-2', workflowName: 'Repository sync' }],
        });
      }),
    );
    const { user } = show('assets');
    await user.click(await screen.findByRole('link', { name: 'Activity' }));
    const first = await screen.findByRole('link', {
      name: /Network discovery.*Manual.*run-1/,
    });
    expect(first).toHaveAttribute('href', '/jobs/runs/run-1');
    expect(
      screen.getByText(/1 done.*0 failed.*1 running.*2 total/),
    ).toBeVisible();
    const more = screen.getByRole('button', { name: 'Load more runs' });
    await user.click(more);
    expect(await screen.findByText('Could not load more runs.')).toBeVisible();
    expect(first).toBeVisible();
    failMore = false;
    expect(more).toHaveFocus();
    await user.keyboard('{Enter}');
    const next = await screen.findByRole('link', { name: /Repository sync/ });
    expect(next).toBeVisible();
    await waitFor(() => expect(next).toHaveFocus());
    expect(first).toBeVisible();
    expect(more).not.toBeInTheDocument();
  });

  it('hides Activity and skips the run request without job read access', async () => {
    canReadJobs.mockReturnValue(false);
    const getRuns = vi.fn(() => HttpResponse.json(pageOne));
    server.use(http.get(runsPath, getRuns));
    show('activity');
    expect(
      await screen.findByText(/don.t have permission to access this page/),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Activity' }),
    ).not.toBeInTheDocument();
    expect(getRuns).not.toHaveBeenCalled();
  });

  it('rechecks permissions and hides cached runs after the API revokes access', async () => {
    server.use(http.get(runsPath, () => HttpResponse.json(pageOne)));
    const { user } = show('activity');
    expect(
      await screen.findByRole('link', { name: /Network discovery/ }),
    ).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Assets', exact: true }));
    server.use(
      http.get(runsPath, async () => {
        await delay(150);
        return new HttpResponse(null, { status: 403 });
      }),
    );
    await user.click(screen.getByRole('link', { name: 'Activity' }));
    expect(
      screen.queryByRole('link', { name: /Network discovery/ }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText(/don.t have permission to access this page/),
    ).toBeVisible();
    expect(refetchPermissions).toHaveBeenCalledTimes(1);
  });
});
