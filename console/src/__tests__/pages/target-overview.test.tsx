import { TargetChangesPanel } from '@/pages/targets/components/target-changes-panel';
import DetailTarget from '@/pages/targets/detail-target';
import { server } from '@/test/mocks/node';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

dayjs.extend(relativeTime);

const canReadAssets = vi.hoisted(() => vi.fn(() => true));
const canReadJobs = vi.hoisted(() => vi.fn(() => true));
const canWriteJobs = vi.hoisted(() => vi.fn(() => false));
const canReadFindings = vi.hoisted(() => vi.fn(() => true));
const canReadProjects = vi.hoisted(() => vi.fn(() => true));
const canWriteTarget = vi.hoisted(() => vi.fn(() => false));
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
      (key === 'job.read' && canReadJobs()) ||
      (key === 'job.write' && canWriteJobs()) ||
      (key === 'vulnerability.read' && canReadFindings()) ||
      (key === 'project.read' && canReadProjects()) ||
      (key === 'target.write' && canWriteTarget()),
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
vi.mock('@/pages/vulnerabilities/vulnerabilities-view', () => ({
  VulnerabilitiesView: () => <p>Target vulnerability list</p>,
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
  canWriteJobs.mockReturnValue(false);
  canReadFindings.mockReturnValue(true);
  canReadProjects.mockReturnValue(true);
  canWriteTarget.mockReturnValue(false);
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
    http.get(`/api${path}/changes`, () =>
      HttpResponse.json({ data: [], page: 1, hasNextPage: false }),
    ),
    http.get(`/api${path}/runs`, () =>
      HttpResponse.json({ data: [], page: 1, hasNextPage: false }),
    ),
  );
});

afterEach(() => {
  onlineManager.setOnline(true);
  setGlobalWorkspaceId(null);
});

describe('Target Overview runs', () => {
  const run = {
    id: '96e23195-3829-45b2-b170-2a16eaf57cbc',
    workflowName: 'Discovery workflow',
    createdAt: '2026-11-01T14:00:00.000Z',
    updatedAt: '2026-11-01T14:05:00.000Z',
    jobRunType: 'scheduled',
    status: 'failed',
    jobsTotal: 3,
    jobsDone: 2,
    jobsFailed: 1,
    jobsRunning: 0,
  };

  const activeRuns = [
    { ...run, workflowName: 'Queued discovery', status: 'pending' },
    {
      ...run,
      id: '08450c37-55f9-42d5-9876-2c212a3d43a1',
      workflowName: 'Running discovery',
      status: 'in_progress',
    },
  ];

  it.each([true, false])(
    'offers cancellation only for open runs and job writers (%s)',
    async (allowed) => {
      canWriteJobs.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({
            ...metrics,
            lastRun: activeRuns[0],
            activeRuns: [
              { ...activeRuns[0], id: 'closed-run', isCompleted: true },
              { ...activeRuns[1], isCompleted: false },
            ],
          }),
        ),
      );
      show();
      await screen.findByRole('region', { name: 'Active runs' });
      const actions = screen.queryAllByRole('button', { name: /Cancel run/ });
      expect(actions).toHaveLength(allowed ? 1 : 0);
      if (allowed) expect(actions[0]).toHaveAccessibleName(/Running discovery/);
    },
  );

  it.each([201, 409])(
    'confirms the whole run and refreshes after cancellation or closure (%s)',
    async (status) => {
      setGlobalWorkspaceId('ws-1');
      canWriteJobs.mockReturnValue(true);
      let running = { ...activeRuns[1], isCompleted: false };
      const cancel = vi.fn(() => {
        running = {
          ...running,
          isCompleted: true,
          status: status === 201 ? 'cancelled' : 'completed',
        };
        return HttpResponse.json({ message: 'Run state changed' }, { status });
      });
      server.use(
        http.get(`/api${path}/runs`, ({ request }) =>
          HttpResponse.json({
            data:
              new URL(request.url).searchParams.has('active') &&
              running.isCompleted
                ? []
                : [running],
            page: 1,
            hasNextPage: false,
          }),
        ),
        http.post(`/api/jobs-registry/histories/${running.id}/cancel`, cancel),
      );
      const { user } = show('activity');
      await user.click(
        await screen.findByRole('switch', { name: 'Active runs only' }),
      );
      const action = await screen.findByRole('button', { name: /Cancel run/ });
      const openDialog = async () => {
        await user.click(action);
        return within(
          await screen.findByRole('dialog', { name: 'Cancel this run?' }),
        );
      };
      const dialog = await openDialog();
      expect(dialog.getByText(/entire run.*other targets/i)).toBeVisible();
      expect(cancel).not.toHaveBeenCalled();
      const keepRun = dialog.getByRole('button', { name: 'Keep run' });
      await waitFor(() => expect(keepRun).toHaveFocus());
      await user.keyboard('{Enter}');
      expect(cancel).not.toHaveBeenCalled();
      const confirmation = await openDialog();
      await user.click(
        confirmation.getByRole('button', { name: 'Cancel run', exact: true }),
      );
      await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(action).not.toBeInTheDocument());
      await waitFor(() =>
        expect(
          screen.getByRole('region', { name: 'Target activity' }),
        ).toHaveFocus(),
      );
    },
  );

  it('dispatches once instead of queueing an offline cancellation', async () => {
    setGlobalWorkspaceId('ws-1');
    canWriteJobs.mockReturnValue(true);
    const running = { ...activeRuns[1], isCompleted: false };
    const cancel = vi.fn(() => HttpResponse.error());
    server.use(
      http.get(`/api${path}/runs`, () =>
        HttpResponse.json({ data: [running], page: 1, hasNextPage: false }),
      ),
      http.post(`/api/jobs-registry/histories/${running.id}/cancel`, cancel),
    );
    const { user } = show('activity');
    const action = await screen.findByRole('button', { name: /Cancel run/ });
    await user.click(action);
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Cancel this run?' }),
    );
    onlineManager.setOnline(false);
    await user.click(
      dialog.getByRole('button', { name: 'Cancel run', exact: true }),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(action).toBeEnabled());
  });

  it('keeps a stale confirmation from cancelling in a different workspace', async () => {
    setGlobalWorkspaceId('ws-1');
    canWriteJobs.mockReturnValue(true);
    const running = { ...activeRuns[1], isCompleted: false };
    const cancel = vi.fn();
    server.use(
      http.get(`/api${path}/runs`, () =>
        HttpResponse.json({ data: [running], page: 1, hasNextPage: false }),
      ),
      http.post(`/api/jobs-registry/histories/${running.id}/cancel`, cancel),
    );
    const { user } = show('activity');
    const action = await screen.findByRole('button', { name: /Cancel run/ });
    await user.click(action);
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Cancel this run?' }),
    );
    setGlobalWorkspaceId('ws-2');
    await user.click(
      dialog.getByRole('button', { name: 'Cancel run', exact: true }),
    );
    await waitFor(() => expect(action).toHaveFocus());
    expect(cancel).not.toHaveBeenCalled();
  });

  it('shows the current target tool in Overview and Activity', async () => {
    const running = { ...activeRuns[1], jobsRunning: 1, currentTool: 'naabu' };
    const pending = { ...activeRuns[0], currentTool: null };
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({
          ...metrics,
          lastRun: running,
          activeRuns: [pending, running],
        }),
      ),
      http.get(`/api${path}/runs`, () =>
        HttpResponse.json({
          data: [running, pending, run],
          page: 1,
          hasNextPage: false,
        }),
      ),
    );
    const { user } = show();
    for (const name of ['Latest run', 'Active runs']) {
      const panel = within(await screen.findByRole('region', { name }));
      expect(panel.getByText('Running tool naabu')).toBeVisible();
      expect(panel.getAllByText(/^Running tool/)).toHaveLength(1);
    }
    await user.click(screen.getByRole('link', { name: 'Activity' }));
    expect(await screen.findByText('Running tool naabu')).toBeVisible();
    expect(screen.getAllByText(/^Running tool/)).toHaveLength(1);
  });

  it.each([true, false])(
    'links the run project only with effective project access (%s)',
    async (allowed) => {
      canReadProjects.mockReturnValue(allowed);
      const projectName = 'Archived target project';
      const linked = {
        ...activeRuns[1],
        projectId: 'project-1',
        projectName,
      };
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({
            ...metrics,
            lastRun: linked,
            activeRuns: [linked],
          }),
        ),
        http.get(`/api${path}/runs`, () =>
          HttpResponse.json({ data: [linked], page: 1, hasNextPage: false }),
        ),
      );
      const { user } = show();
      await screen.findByRole('region', { name: 'Active runs' });
      const projectLinks = () =>
        screen.queryAllByRole('link', { name: projectName });
      expect(projectLinks()).toHaveLength(allowed ? 2 : 0);
      for (const link of projectLinks()) {
        expect(link).toHaveAttribute('href', '/projects/project-1');
      }
      await user.click(screen.getByRole('link', { name: 'Activity' }));
      await screen.findByRole('link', { name: /Running discovery/ });
      expect(projectLinks()).toHaveLength(allowed ? 1 : 0);
    },
  );

  it.each([true, false])(
    'shows positive per-run findings only with vulnerability access (%s)',
    async (allowed) => {
      canReadFindings.mockReturnValue(allowed);
      const latest = { ...run, newVulnerabilities: 1 };
      const pending = {
        ...activeRuns[0],
        id: 'pending-run-1',
        newVulnerabilities: 0,
      };
      const running = { ...activeRuns[1], newVulnerabilities: 3 };
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({
            ...metrics,
            lastRun: latest,
            activeRuns: [pending, running],
          }),
        ),
        http.get(`/api${path}/runs`, () =>
          HttpResponse.json({
            data: [latest, pending, running],
            page: 1,
            hasNextPage: false,
          }),
        ),
      );
      const { user } = show();
      await screen.findByRole('region', { name: 'Active runs' });
      const assertCounts = () => {
        expect(
          screen.queryAllByText('1 new finding', { exact: true }),
        ).toHaveLength(allowed ? 1 : 0);
        expect(
          screen.queryAllByText('3 new findings', { exact: true }),
        ).toHaveLength(allowed ? 1 : 0);
        expect(
          screen.queryByText('0 new findings', { exact: true }),
        ).not.toBeInTheDocument();
      };
      assertCounts();
      await user.click(screen.getByRole('link', { name: 'Activity' }));
      await screen.findByRole('link', { name: /Running discovery/ });
      assertCounts();
    },
  );

  it('shows active runs in API order and links to each run', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, activeRuns }),
      ),
    );
    show();
    const active = within(
      await screen.findByRole('region', { name: 'Active runs' }),
    );
    expect(
      active.getAllByRole('link').map((link) => link.getAttribute('href')),
    ).toEqual(activeRuns.map(({ id }) => `/jobs/runs/${id}`));
    expect(active.getByText('Pending')).toBeVisible();
    expect(active.getByText('In Progress')).toBeVisible();
  });

  it.each([
    { allowed: false, runs: activeRuns },
    { allowed: true, runs: [] },
    { allowed: true, runs: null },
    { allowed: true, runs: undefined },
  ])(
    'hides unavailable or empty active runs ($allowed, $runs)',
    async ({ allowed, runs }) => {
      canReadJobs.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({ ...metrics, activeRuns: runs }),
        ),
      );
      show();
      expect(await screen.findByText('Enabled assets')).toBeVisible();
      expect(
        screen.queryByRole('region', { name: 'Active runs' }),
      ).not.toBeInTheDocument();
    },
  );

  it('shows the latest run details and link to the run', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, lastRun: run }),
      ),
    );
    show();
    const latest = within(
      await screen.findByRole('region', { name: 'Latest run' }),
    );
    expect(
      latest.getByRole('link', { name: /Discovery workflow/ }),
    ).toHaveAttribute('href', `/jobs/runs/${run.id}`);
    expect(latest.getByText('Scheduled')).toBeVisible();
    expect(latest.getByText('Failed')).toBeVisible();
    expect(
      latest.getByText(
        'Status covers the whole run. Job counts are for this target.',
      ),
    ).toBeVisible();
    expect(
      latest.getByText('2 done · 1 failed · 0 running · 3 total'),
    ).toBeVisible();
  });

  it('shows the empty state when the API returns no run', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, lastRun: null }),
      ),
    );
    show();
    expect(await screen.findByText('No runs to show.')).toBeVisible();
  });

  it.each([
    { allowed: false, lastRun: run },
    { allowed: true, lastRun: undefined },
  ])(
    'hides the card without access or an API field ($allowed)',
    async ({ allowed, lastRun }) => {
      canReadJobs.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({ ...metrics, lastRun }),
        ),
      );
      show();
      expect(await screen.findByText('Enabled assets')).toBeVisible();
      expect(
        screen.queryByRole('region', { name: 'Latest run' }),
      ).not.toBeInTheDocument();
    },
  );
});

describe('Target Overview tab', () => {
  const failedRun = '96e23195-3829-45b2-b170-2a16eaf57cbc';
  it.each([
    { allowed: true, runId: failedRun },
    { allowed: false, runId: failedRun },
    { allowed: true, runId: '..' },
  ])(
    'only links a valid failed run with job read access ($allowed, $runId)',
    async ({ allowed, runId }) => {
      canReadJobs.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({
            ...metrics,
            insights: [
              { kind: 'last_run_failed', level: 'warning', runId },
              { kind: 'no_schedule', level: 'info' },
            ],
          }),
        ),
      );
      show();
      const insights = within(
        await screen.findByRole('region', { name: 'Discovery insights' }),
      );
      expect(insights.getByText('No discovery schedule.')).toBeVisible();
      const warning = insights.queryByText('The latest target run failed.');
      if (allowed) expect(warning).toBeVisible();
      else expect(warning).not.toBeInTheDocument();
      if (allowed && runId === failedRun) {
        expect(
          insights.getByRole('link', { name: 'Open run' }),
        ).toHaveAttribute('href', `/jobs/runs/${runId}`);
      } else {
        expect(
          insights.queryByRole('link', { name: 'Open run' }),
        ).not.toBeInTheDocument();
      }
    },
  );

  it('shows TLS expiry to asset readers and opens the TLS inventory by keyboard', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({
          ...metrics,
          insights: [
            { kind: 'tls_expiring', level: 'warning', count: 2, days: 30 },
          ],
        }),
      ),
    );
    const { user, router } = show();
    const insights = within(
      await screen.findByRole('region', { name: 'Discovery insights' }),
    );
    expect(
      insights.getByText(
        'The latest recorded TLS certificates for 2 services have expired or expire within 30 days.',
      ),
    ).toBeVisible();
    const tls = insights.getByRole('link', { name: 'See TLS' });
    expect(tls).toHaveAttribute('href', `${path}/assets?tab=tls`);
    tls.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Asset inventory')).toBeVisible();
    expect(router.state.location.searchStr).toBe('?tab=tls');
    const nav = within(
      screen.getByRole('navigation', { name: 'Target sections' }),
    );
    expect(
      nav.getByRole('link', { name: 'Assets', exact: true }),
    ).toHaveFocus();
  });

  it.each([true, false])(
    'shows discovery insights with target write access %s',
    async (canWrite) => {
      canWriteTarget.mockReturnValue(canWrite);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({
            ...metrics,
            insights: [
              { kind: 'stale_scan', level: 'warning' },
              { kind: 'new_assets', level: 'info', count: 2, days: 7 },
              { kind: 'no_schedule', level: 'info' },
            ],
          }),
        ),
      );
      const { user } = show();
      const insights = within(
        await screen.findByRole('region', { name: 'Discovery insights' }),
      );
      expect(insights.getByText('No discovery date recorded.')).toBeVisible();
      expect(
        insights.getByText('2 new assets in the last 7 days.'),
      ).toBeVisible();
      expect(insights.getByText('No discovery schedule.')).toBeVisible();
      expect(
        insights.getByRole('link', { name: 'See assets' }),
      ).toHaveAttribute('href', `${path}/assets`);
      if (canWrite) {
        expect(
          insights.getByRole('link', { name: 'Open discovery settings' }),
        ).toHaveAttribute('href', `${path}/settings`);
        expect(
          insights.getByRole('link', { name: 'Configure schedule' }),
        ).toHaveAttribute('href', `${path}/settings`);
      } else {
        expect(
          insights.queryByRole('link', { name: /settings|schedule/ }),
        ).not.toBeInTheDocument();
        insights.getByRole('link', { name: 'See assets' }).focus();
        await user.keyboard('{Enter}');
        expect(await screen.findByText('Asset inventory')).toBeVisible();
        const nav = within(
          screen.getByRole('navigation', { name: 'Target sections' }),
        );
        expect(
          nav.getByRole('link', { name: 'Assets', exact: true }),
        ).toHaveFocus();
      }
    },
  );

  it('describes discoveries without inventing optional metadata', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({
          ...metrics,
          insights: [
            { kind: 'new_assets', level: 'info' },
            { kind: 'future_insight', level: 'warning' },
          ],
        }),
      ),
    );
    show();
    expect(await screen.findByText('New assets discovered.')).toBeVisible();
    const insights = within(
      screen.getByRole('region', { name: 'Discovery insights' }),
    );
    expect(insights.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows ranked exposure groups and their service counts', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({
          ...metrics,
          exposure: {
            ports: [
              { name: '443', count: 2 },
              { name: '80', count: 1 },
            ],
            technologies: [{ name: 'Nginx', count: 2 }],
            statusCodes: [{ name: '200', count: 2 }],
          },
        }),
      ),
    );
    show();
    const exposure = within(
      await screen.findByRole('region', { name: 'Target exposure' }),
    );
    const ports = within(exposure.getByRole('list', { name: 'Ports' }));
    const rows = ports.getAllByRole('listitem');
    expect(within(rows[0]).getByText('443')).toBeVisible();
    expect(within(rows[0]).getByText('2 services')).toBeVisible();
    expect(within(rows[1]).getByText('1 service')).toBeVisible();
    expect(
      within(exposure.getByRole('list', { name: 'Technologies' })).getByText(
        'Nginx',
      ),
    ).toBeVisible();
    expect(
      within(
        exposure.getByRole('list', { name: 'Primary HTTP status codes' }),
      ).getByText('200'),
    ).toBeVisible();
  });

  it('shows empty exposure groups without empty lists', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({
          ...metrics,
          exposure: { ports: [], technologies: [], statusCodes: [] },
        }),
      ),
    );
    show();
    const exposure = within(
      await screen.findByRole('region', { name: 'Target exposure' }),
    );
    expect(exposure.getByText('No ports discovered.')).toBeVisible();
    expect(exposure.getByText('No technologies detected.')).toBeVisible();
    expect(exposure.getByText('No HTTP status codes recorded.')).toBeVisible();
    expect(exposure.queryByRole('list')).not.toBeInTheDocument();
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

describe('Target Overview next discovery', () => {
  it('shows the scheduled time with a machine-readable timestamp', async () => {
    const nextScanAt = '2026-12-01T05:00:00.000Z';
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, nextScanAt }),
      ),
    );
    show();
    expect(await screen.findByText('Scheduled discovery')).toBeVisible();
    const formatted = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(nextScanAt));
    expect(screen.getByText(formatted)).toHaveAttribute('datetime', nextScanAt);
  });

  it.each([null, undefined, 'invalid', 42])(
    'shows an unavailable state for a missing or invalid schedule (%s)',
    async (nextScanAt) => {
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({ ...metrics, nextScanAt }),
        ),
      );
      show();
      expect(
        await screen.findByText('No scheduled time available'),
      ).toBeVisible();
    },
  );
});

describe('Target Overview top findings', () => {
  const findings = [
    {
      id: 'e16f1518-0345-4ae9-b195-fc1955c53227',
      name: 'Critical finding',
      severity: 'critical',
      assetValue: 'target.example.test',
      cveId: ['CVE-2026-12345'],
      createdAt: '2026-11-01T14:00:00.000Z',
    },
    {
      id: 'c98206de-2f97-4e18-bb4c-a1bd4e24641e',
      name: 'High finding',
      severity: 'high',
      assetValue: 'other.example.test',
      cveId: null,
      createdAt: '2026-11-02T14:00:00.000Z',
    },
  ];

  it('shows ranked findings with asset, severity and the existing detail link', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, topVulnerabilities: findings }),
      ),
    );
    show();
    const top = within(
      await screen.findByRole('region', { name: 'Top findings' }),
    );
    expect(
      top.getAllByRole('link').map((link) => link.getAttribute('href')),
    ).toEqual(findings.map(({ id }) => `/vulnerabilities/${id}`));
    expect(top.getByText('critical')).toBeVisible();
    expect(top.getByText('target.example.test')).toBeVisible();
    expect(top.getByText('CVE-2026-12345')).toBeVisible();
  });

  it('shows an empty state for an authorized empty ranking', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, topVulnerabilities: [] }),
      ),
    );
    show();
    const top = within(
      await screen.findByRole('region', { name: 'Top findings' }),
    );
    expect(top.getByText('No findings to preview.')).toBeVisible();
  });

  it.each([
    { allowed: false, data: findings },
    { allowed: true, data: null },
    { allowed: true, data: undefined },
  ])(
    'hides redacted or unavailable rankings ($allowed)',
    async ({ allowed, data }) => {
      canReadFindings.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({ ...metrics, topVulnerabilities: data }),
        ),
      );
      show();
      expect(await screen.findByText('Enabled assets')).toBeVisible();
      expect(
        screen.queryByRole('region', { name: 'Top findings' }),
      ).not.toBeInTheDocument();
    },
  );
});

describe('Target Overview findings', () => {
  const findings = { critical: 1, high: 2, medium: 0, low: 0, info: 0 };

  it.each([true, false])(
    'only shows the critical insight and its action with vulnerability read access %s',
    async (allowed) => {
      canReadFindings.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({
            ...metrics,
            insights: [
              { kind: 'critical_open', level: 'critical', count: 2 },
              { kind: 'no_schedule', level: 'info' },
            ],
          }),
        ),
      );
      show();
      const insights = within(
        await screen.findByRole('region', { name: 'Discovery insights' }),
      );
      const warning = insights.queryByText('2 open critical vulnerabilities.');
      const action = insights.queryByRole('link', {
        name: 'Review vulnerabilities',
      });
      if (allowed) {
        expect(insights.getByText('Critical', { exact: true })).toBeVisible();
        expect(warning).toBeVisible();
        expect(action).toHaveAttribute('href', `${path}/vulnerabilities`);
      } else {
        expect(warning).not.toBeInTheDocument();
        expect(action).not.toBeInTheDocument();
      }
    },
  );

  it('shows finding counts and transfers focus when opening the target list by keyboard', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({
          ...metrics,
          openVulnerabilities: findings,
          newVulnerabilities: 2,
        }),
      ),
    );
    const { user, router } = show();
    const card = within(
      await screen.findByRole('region', { name: 'Open vulnerabilities' }),
    );
    expect(card.getByText('3')).toBeVisible();
    expect(card.getByText('2 new in the last 7 days')).toBeVisible();
    expect(card.getByText('critical')).toBeVisible();
    const link = card.getByRole('link', { name: 'See vulnerabilities' });
    expect(link).toHaveAttribute('href', `${path}/vulnerabilities`);
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Target vulnerability list')).toBeVisible();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${path}/vulnerabilities`);
      const nav = within(
        screen.getByRole('navigation', { name: 'Target sections' }),
      );
      expect(nav.getByRole('link', { name: 'Vulnerabilities' })).toHaveFocus();
    });
  });

  it.each([
    {
      allowed: false,
      fields: { openVulnerabilities: findings, newVulnerabilities: 2 },
    },
    {
      allowed: true,
      fields: { openVulnerabilities: null, newVulnerabilities: null },
    },
    { allowed: true, fields: {} },
  ])(
    'hides unavailable finding counts ($allowed, $fields)',
    async ({ allowed, fields }) => {
      canReadFindings.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({ ...metrics, ...fields }),
        ),
      );
      show();
      expect(await screen.findByText('Enabled assets')).toBeVisible();
      expect(
        screen.queryByRole('region', { name: 'Open vulnerabilities' }),
      ).not.toBeInTheDocument();
    },
  );
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
    projectId: 'project-1',
    projectName: 'Network project',
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
    expect(screen.getByRole('link', { name: 'Network project' })).toBeVisible();
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

  it('hides Activity and skips both requests without job or asset read access', async () => {
    canReadAssets.mockReturnValue(false);
    canReadJobs.mockReturnValue(false);
    const getRuns = vi.fn(() => HttpResponse.json(pageOne));
    const getChanges = vi.fn();
    server.use(
      http.get(runsPath, getRuns),
      http.get(`/api${path}/changes`, getChanges),
    );
    show('activity');
    expect(
      await screen.findByText(/don.t have permission to access this page/),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Activity' }),
    ).not.toBeInTheDocument();
    expect(getRuns).not.toHaveBeenCalled();
    expect(getChanges).not.toHaveBeenCalled();
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

describe('Target Overview projects', () => {
  const projects = [
    { id: 'project-1', name: 'Inventory', assets: 2, hexColor: '#123456' },
    { id: 'project-2', name: 'External', assets: 1, hexColor: null },
  ];
  const panelName = 'Projects containing target assets';

  it('links projects in API order and shows target-specific counts', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, projects }),
      ),
    );
    show();
    const panel = within(
      await screen.findByRole('region', { name: panelName }),
    );
    expect(
      panel.getAllByRole('link').map((link) => link.getAttribute('href')),
    ).toEqual(['/projects/project-1', '/projects/project-2']);
    expect(panel.getByText('2 target assets')).toBeVisible();
    expect(panel.getByText('1 target asset')).toBeVisible();
  });

  it('shows an empty state for an authorized target without projects', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, projects: [] }),
      ),
    );
    show();
    expect(
      await screen.findByText('No projects contain assets from this target.'),
    ).toBeVisible();
  });

  it.each([
    { allowed: false, response: projects },
    { allowed: true, response: null },
    { allowed: true, response: undefined },
  ])(
    'hides missing or redacted projects ($allowed, $response)',
    async ({ allowed, response }) => {
      canReadProjects.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({ ...metrics, projects: response }),
        ),
      );
      show();
      expect(await screen.findByText('Enabled assets')).toBeVisible();
      expect(
        screen.queryByRole('region', { name: panelName }),
      ).not.toBeInTheDocument();
    },
  );
});

describe('Target Overview weekly findings', () => {
  const emptyWeeks = Array.from({ length: 8 }, (_, index) => ({
    week: new Date(Date.UTC(2026, 8, 14 + index * 7))
      .toISOString()
      .slice(0, 10),
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  }));
  const weekly = emptyWeeks.map((week, index) => ({
    ...week,
    high: index === 0 ? 3 : 0,
  }));

  it('shows the eight weeks and exact counts through the keyboard', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({ ...metrics, weekly }),
      ),
    );
    const { user } = show();
    const trends = within(
      await screen.findByRole('region', { name: 'New findings by week' }),
    );
    const toggle = trends.getByText('View weekly counts');
    toggle.focus();
    await user.keyboard('{Enter}');
    const rows = within(trends.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(9);
    expect(rows[1].querySelector('time')).toHaveAttribute(
      'datetime',
      weekly[0].week,
    );
    expect(
      within(rows[1])
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['0', '3', '0', '0', '0', '3']);
  });

  it('explains zero buckets when findings have no recognized severity', async () => {
    server.use(
      http.get(`/api${path}/overview`, () =>
        HttpResponse.json({
          ...metrics,
          newVulnerabilities: 1,
          weekly: emptyWeeks,
        }),
      ),
    );
    show();
    expect(
      await screen.findByText(
        'No findings of these severities in the last eight weeks.',
      ),
    ).toBeVisible();
  });

  it.each([
    { allowed: false, response: weekly },
    { allowed: true, response: null },
    { allowed: true, response: undefined },
  ])(
    'hides missing or redacted weekly counts ($allowed, $response)',
    async ({ allowed, response }) => {
      canReadFindings.mockReturnValue(allowed);
      server.use(
        http.get(`/api${path}/overview`, () =>
          HttpResponse.json({ ...metrics, weekly: response }),
        ),
      );
      show();
      expect(await screen.findByText('Enabled assets')).toBeVisible();
      expect(
        screen.queryByRole('region', { name: 'New findings by week' }),
      ).not.toBeInTheDocument();
    },
  );
});

describe('Target discovery changes', () => {
  const changesPath = `/api${path}/changes`;
  const asset = {
    kind: 'asset',
    id: 'asset-1',
    at: '2026-01-02T03:04:05Z',
    label: 'new.example.test',
    assetValue: null,
  };
  const service = {
    ...asset,
    kind: 'service',
    id: 'service-1',
    label: 'https://new.example.test:8443',
    assetValue: asset.label,
  };

  it.each([true, false])(
    'labels mixed-feed findings only with vulnerability access (%s)',
    async (allowed) => {
      canReadFindings.mockReturnValue(allowed);
      server.use(
        http.get(changesPath, () =>
          HttpResponse.json({
            page: 1,
            hasNextPage: false,
            data: [
              asset,
              {
                ...service,
                id: 'finding-1',
                kind: 'vulnerability',
                label: 'Historic finding',
              },
            ],
          }),
        ),
      );
      show('activity');
      expect(await screen.findByText(asset.label)).toBeVisible();
      const finding = screen.queryByText('Historic finding');
      if (allowed) {
        expect(finding).toBeVisible();
        expect(screen.getByText('Finding discovered')).toBeVisible();
      } else {
        expect(finding).not.toBeInTheDocument();
        expect(
          screen.queryByRole('button', { name: 'Findings' }),
        ).not.toBeInTheDocument();
      }
    },
  );

  it('removes findings and refreshes the mounted feed when access changes', async () => {
    const getChanges = vi.fn(() =>
      HttpResponse.json({
        page: 1,
        hasNextPage: false,
        data: [asset, { ...service, kind: 'vulnerability', label: 'Finding' }],
      }),
    );
    server.use(http.get(changesPath, getChanges));
    const client = new QueryClient();
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory(),
    });
    const onAccessDenied = vi.fn();
    const view = (allowed: boolean) => (
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <TargetChangesPanel
            targetId={id}
            canReadFindings={allowed}
            onAccessDenied={onAccessDenied}
          />
        </RouterContextProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(view(true));
    expect(await screen.findByText('Finding')).toBeVisible();
    rerender(view(false));
    expect(screen.queryByText('Finding')).not.toBeInTheDocument();
    expect(await screen.findByText(asset.label)).toBeVisible();
    expect(screen.queryByText('Finding')).not.toBeInTheDocument();
    expect(getChanges).toHaveBeenCalledTimes(2);
  });

  it('filters finding discoveries, resets the page, and links each finding', async () => {
    const finding = {
      ...service,
      id: 'finding-1',
      kind: 'vulnerability',
      label: 'Historic finding',
      severity: 'high',
    };
    const legacy = { ...finding, id: 'finding-2', label: 'Legacy finding' };
    server.use(
      http.get(changesPath, ({ request }) => {
        const params = new URL(request.url).searchParams;
        const page = Number(params.get('page'));
        const filtered = params.get('kind') === 'vulnerability';
        return HttpResponse.json({
          page,
          hasNextPage: page === 1 && !filtered,
          data: filtered
            ? [finding, { ...legacy, severity: undefined }]
            : [asset],
        });
      }),
    );
    const { user } = show('activity');
    const feed = within(
      await screen.findByRole('region', { name: 'Target changes' }),
    );
    expect(await feed.findByText(asset.label)).toBeVisible();
    await user.click(feed.getByRole('button', { name: 'Next page' }));
    expect(await feed.findByText('Page 2')).toBeVisible();
    expect(await feed.findByText(asset.label)).toBeVisible();

    const filter = feed.getByRole('button', { name: 'Findings' });
    await user.click(filter);
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    expect(await feed.findByText('Page 1')).toBeVisible();
    expect(
      await feed.findByRole('link', {
        name: `${finding.label} on ${asset.label}`,
        exact: true,
      }),
    ).toHaveAttribute('href', '/vulnerabilities/finding-1');
    expect(
      feed.getByRole('link', { name: `${legacy.label} on ${asset.label}` }),
    ).toHaveAttribute('href', '/vulnerabilities/finding-2');
    expect(feed.getByText('high')).toBeVisible();
    expect(feed.queryByText(asset.label)).not.toBeInTheDocument();
  });

  it('lists and filters discoveries without job read access and resets pagination on filter change', async () => {
    canReadJobs.mockReturnValue(false);
    const getRuns = vi.fn();
    server.use(
      http.get(`/api${path}/runs`, getRuns),
      http.get(changesPath, ({ request }) => {
        const params = new URL(request.url).searchParams;
        const page = Number(params.get('page'));
        const kind = params.get('kind');
        return HttpResponse.json({
          page,
          hasNextPage: page === 1 && !kind,
          data: page === 2 || kind === 'service' ? [service] : [asset],
        });
      }),
    );
    const { user } = show('assets');
    await user.click(await screen.findByRole('link', { name: 'Activity' }));
    const changes = within(
      await screen.findByRole('region', { name: 'Target changes' }),
    );
    expect(await changes.findByText(asset.label)).toBeVisible();
    expect(getRuns).not.toHaveBeenCalled();
    const next = changes.getByRole('button', { name: 'Next page' });
    await user.click(next);
    expect(await changes.findByText(service.label)).toBeVisible();
    expect(changes.getByText('Page 2')).toBeVisible();
    expect(next).toHaveFocus();
    const services = changes.getByRole('button', { name: 'Services' });
    await user.click(services);
    expect(services).toHaveAttribute('aria-pressed', 'true');
    expect(await changes.findByText('Page 1')).toBeVisible();
    expect(await changes.findByText(service.label)).toBeVisible();
  });

  it('hides changes without asset read access and does not request them', async () => {
    canReadAssets.mockReturnValue(false);
    const getChanges = vi.fn();
    server.use(http.get(changesPath, getChanges));
    show('activity');
    expect(
      await screen.findByRole('region', { name: 'Target activity' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'Target changes' }),
    ).not.toBeInTheDocument();
    expect(getChanges).not.toHaveBeenCalled();
  });

  it('moves keyboard focus to the feed heading after a successful retry', async () => {
    server.use(
      http.get(changesPath, () => new HttpResponse(null, { status: 503 })),
    );
    const { user } = show('activity');
    const retry = await screen.findByRole('button', {
      name: 'Retry discoveries',
    });
    server.use(
      http.get(changesPath, () =>
        HttpResponse.json({ page: 1, data: [asset] }),
      ),
    );
    retry.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(asset.label)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Changes' })).toHaveFocus(),
    );
  });

  it('clears previously shown discoveries and rechecks permissions on a forbidden response', async () => {
    canReadJobs.mockReturnValue(false);
    server.use(
      http.get(changesPath, () =>
        HttpResponse.json({ page: 1, data: [asset] }),
      ),
    );
    const { user } = show('activity');
    expect(await screen.findByText(asset.label)).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Assets', exact: true }));
    server.use(
      http.get(changesPath, async () => {
        await delay(150);
        return new HttpResponse(null, { status: 403 });
      }),
    );
    await user.click(screen.getByRole('link', { name: 'Activity' }));
    expect(screen.queryByText(asset.label)).not.toBeInTheDocument();
    expect(
      await screen.findByText(/don.t have permission to access this page/),
    ).toBeVisible();
    expect(refetchPermissions).toHaveBeenCalledTimes(1);
  });
});
