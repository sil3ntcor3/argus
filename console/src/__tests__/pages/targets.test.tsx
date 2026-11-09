import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, within } from '@testing-library/react';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/node';
import { mockTargets } from '@/test/mocks/data';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import StartDiscovery from '@/pages/targets/start-discovery';
import Targets from '@/pages/targets/targets';

const canReadFindings = vi.hoisted(() => vi.fn(() => true));
const criticalAccessNotice = /critical findings view requires vulnerability read access/i;
const summary = {
  total: 2,
  scanning: 1,
  scheduled: 0,
  stale: 1,
  withCritical: 1,
  openVulnerabilities: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
};
const mockWorkspaces = [{ id: 'ws-1', name: 'Test Workspace' }];

vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceSelector: () => ({
    workspaces: mockWorkspaces,
    selectedWorkspace: 'ws-1',
    isLoading: false,
  }),
  useWorkspaceState: () => ({
    state: { selectedWorkspaceId: 'ws-1' },
  }),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    permissions: ['*'],
    isOwner: true,
    hasPermission: (key: string) =>
      key !== 'vulnerability.read' || canReadFindings(),
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

describe('Targets Page', () => {
  beforeEach(() => {
    canReadFindings.mockReturnValue(true);
    server.use(
      http.get('/api/targets/summary', () => HttpResponse.json(summary)),
    );
  });

  it('shows workspace target counts and includes a real zero', async () => {
    renderWithProviders(<Targets />, { routePath: '/_authed/targets/' });

    const region = within(
      await screen.findByRole('region', { name: 'Target summary' }),
    );
    expect(await region.findByText('Scheduled')).toBeVisible();
    expect(region.getByText('0', { exact: true })).toBeVisible();
    expect(region.getByText('With critical findings')).toBeVisible();
    expect(region.getByText('Total targets')).toBeVisible();
  });

  it('omits the critical card when the endpoint redacts its count', async () => {
    server.use(
      http.get('/api/targets/summary', () =>
        HttpResponse.json({
          ...summary,
          withCritical: null,
          openVulnerabilities: null,
        }),
      ),
    );
    renderWithProviders(<Targets />, { routePath: '/_authed/targets/' });

    const region = within(
      await screen.findByRole('region', { name: 'Target summary' }),
    );
    expect(await region.findByText('Total targets')).toBeVisible();
    expect(
      region.queryByText('With critical findings'),
    ).not.toBeInTheDocument();
  });

  it('keeps summaries out of broad target-list refetches', async () => {
    const fetchSummary = vi.fn(() => HttpResponse.json(summary));
    server.use(http.get('/api/targets/summary', fetchSummary));
    const { queryClient } = renderWithProviders(<Targets />, {
      routePath: '/_authed/targets/',
    });
    expect(await screen.findByText('Total targets')).toBeVisible();
    await queryClient.refetchQueries({ queryKey: ['targets'] });
    expect(fetchSummary).toHaveBeenCalledTimes(1);
  });

  it('hides the critical count when current permissions deny findings access', async () => {
    canReadFindings.mockReturnValue(false);
    renderWithProviders(<Targets />, { routePath: '/_authed/targets/' });

    const region = within(
      await screen.findByRole('region', { name: 'Target summary' }),
    );
    expect(await region.findByText('Total targets')).toBeVisible();
    expect(
      region.queryByText('With critical findings'),
    ).not.toBeInTheDocument();
  });

  it('keeps the table usable when the summary fails and allows retry', async () => {
    server.use(
      http.get(
        '/api/targets/summary',
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    const { user } = renderWithProviders(<Targets />, {
      routePath: '/_authed/targets/',
    });

    expect(await screen.findByText('example.com')).toBeVisible();
    const region = within(
      await screen.findByRole('region', { name: 'Target summary' }),
    );
    const retry = await region.findByRole('button', { name: 'Retry summary' });
    server.use(
      http.get('/api/targets/summary', async () => {
        await delay(150);
        return HttpResponse.json(summary);
      }),
    );
    await user.click(retry);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(await region.findByText('Total targets')).toBeVisible();
  });

  it('uses server-side quick views, resetting page and clearing selection', async () => {
    const requests: URLSearchParams[] = [];
    server.use(
      http.get('/api/targets', ({ request }) => {
        const params = new URL(request.url).searchParams;
        requests.push(params);
        const data = params.has('hasCritical')
          ? mockTargets.slice(0, 1)
          : params.has('stale')
            ? mockTargets.slice(1)
            : mockTargets;
        return HttpResponse.json({ data, total: data.length });
      }),
    );
    const { router, user } = renderWithProviders(<Targets />, {
      routePath: '/_authed/targets/',
      initialEntries: ['/_authed/targets/?page=2&sortBy=value'],
    });
    const all = await screen.findByRole('button', { name: 'All targets' });
    const critical = screen.getByRole('button', {
      name: 'Open critical findings',
    });
    const stale = screen.getByRole('button', { name: 'Stale targets' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    const row = within(
      await screen.findByRole('row', { name: /example\.com/ }),
    );
    await user.click(row.getByRole('checkbox', { name: 'Select row' }));
    expect(row.getByRole('checkbox', { name: 'Select row' })).toBeChecked();

    await user.click(critical);
    await waitFor(() =>
      expect(requests.at(-1)?.get('hasCritical')).toBe('true'),
    );
    expect(requests.at(-1)?.get('page')).toBe('1');
    expect(requests.at(-1)?.get('sortBy')).toBe('value');
    expect(router.state.location.search).toMatchObject({ view: 'critical' });
    expect(critical).toHaveAttribute('aria-pressed', 'true');
    const filtered = within(
      await screen.findByRole('row', { name: /example\.com/ }),
    );
    expect(
      filtered.getByRole('checkbox', { name: 'Select row' }),
    ).not.toBeChecked();
    expect(screen.queryByText('192.168.1.1')).not.toBeInTheDocument();

    await user.click(stale);
    expect(await screen.findByText('192.168.1.1')).toBeVisible();
    expect(requests.at(-1)?.get('stale')).toBe('true');
    expect(requests.at(-1)?.has('hasCritical')).toBe(false);
    expect(stale).toHaveAttribute('aria-pressed', 'true');

    await user.click(all);
    expect(await screen.findByText('example.com')).toBeVisible();
    expect(requests.at(-1)?.has('stale')).toBe(false);
    expect(router.state.location.search).not.toHaveProperty('view');
  });

  it('keeps a restricted deep link from requesting critical targets', async () => {
    canReadFindings.mockReturnValue(false);
    const requests: URLSearchParams[] = [];
    server.use(
      http.get('/api/targets', ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          data: mockTargets,
          total: mockTargets.length,
        });
      }),
    );
    renderWithProviders(<Targets />, {
      routePath: '/_authed/targets/',
      initialEntries: ['/_authed/targets/?view=critical'],
    });
    expect(await screen.findByText('example.com')).toBeVisible();
    expect(screen.getByText(criticalAccessNotice)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Open critical findings' }),
    ).not.toBeInTheDocument();
    expect(requests.every((params) => !params.has('hasCritical'))).toBe(true);
  });

  it('requires a fresh response before showing a cached critical page after revocation', async () => {
    let permitted = true;
    server.use(
      http.get('/api/targets', async ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (params.has('hasCritical')) {
          const page = params.get('page');
          if (!permitted) {
            if (page === '1') await delay(250);
            return new HttpResponse(null, { status: 403 });
          }
          const data = [
            { ...mockTargets[0], value: `critical-page-${page}.example.test` },
          ];
          return HttpResponse.json({ data, total: 2 });
        }
        return HttpResponse.json({
          data: mockTargets,
          total: mockTargets.length,
        });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { router, user } = renderWithProviders(<Targets />, {
      queryClient,
      routePath: '/_authed/targets/',
      initialEntries: ['/_authed/targets/?view=critical'],
    });
    expect(
      await screen.findByText('critical-page-1.example.test'),
    ).toBeVisible();
    await act(async () => {
      await router.navigate({ search: (prev) => ({ ...prev, page: 2 }) });
    });
    expect(
      await screen.findByText('critical-page-2.example.test'),
    ).toBeVisible();
    permitted = false;
    await queryClient.refetchQueries({
      queryKey: ['targets', 'ws-1'],
      type: 'active',
    });
    expect(await screen.findByText(criticalAccessNotice)).toBeVisible();
    expect(
      screen.queryByText('critical-page-2.example.test'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All targets' }));
    expect(await screen.findByText('example.com')).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Open critical findings' }),
    );
    expect(
      screen.queryByText('critical-page-1.example.test'),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(criticalAccessNotice)).toBeVisible();
  });

  it('does not replay a discovery submission into a workspace selected after submit', async () => {
    const requestWorkspaces: (string | null)[] = [];
    server.use(
      http.post('/api/targets/bulk', ({ request }) => {
        requestWorkspaces.push(request.headers.get('X-Workspace-Id'));
        return HttpResponse.json(
          { totalCreated: 1, totalSkipped: 0 },
          { status: 201 },
        );
      }),
    );
    setGlobalWorkspaceId('ws-1');
    onlineManager.setOnline(false);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    try {
      const { queryClient, user } = renderWithProviders(<StartDiscovery />, {
        routePath: '/targets/start-discovery',
      });
      await user.type(
        await screen.findByRole('textbox'),
        'target.example.test',
      );
      await user.click(
        screen.getByRole('button', { name: 'Start Discovery', exact: true }),
      );
      const mutations = queryClient.getMutationCache();
      await waitFor(() => expect(mutations.getAll()).toHaveLength(1));
      act(() => {
        setGlobalWorkspaceId('ws-2');
        onlineManager.setOnline(true);
      });
      await waitFor(() =>
        expect(mutations.getAll()[0]?.state.status).not.toBe('pending'),
      );
      expect(requestWorkspaces).not.toContain('ws-2');
    } finally {
      vi.unstubAllGlobals();
      setGlobalWorkspaceId(null);
      onlineManager.setOnline(true);
    }
  });

  it('renders targets table with data', async () => {
    renderWithProviders(<Targets />, {
      routePath: '/_authed/targets/',
      initialEntries: ['/_authed/targets/'],
    });

    await waitFor(() => {
      expect(screen.getByText('example.com')).toBeInTheDocument();
      expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    });

    expect(screen.getByText('Target')).toBeInTheDocument();
    expect(screen.getByText('Surface')).toBeInTheDocument();
    expect(screen.getByText('Sort by services')).toBeInTheDocument();
    // Type is a badge column; Source is an icon next to the target, not a column
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Domain')).toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });

  it('shows target surface and saved discovery cadence from the list response', async () => {
    const [domain, organization] = mockTargets;
    server.use(
      http.get('/api/targets', () =>
        HttpResponse.json({
          data: [
            { ...domain, totalAssets: 2, scanSchedule: '0 0 * * *' },
            {
              ...organization,
              value: 'github.com/argus-test',
              type: 'GIT_ORG',
              totalAssets: 1,
              lastDiscoveredAt: null,
            },
          ],
          total: 2,
          page: 1,
          totalPages: 1,
        }),
      ),
    );
    renderWithProviders(<Targets />, { routePath: '/_authed/targets/' });

    const domainRow = within(
      await screen.findByRole('row', { name: /example\.com/ }),
    );
    expect(domainRow.getByText('5 services')).toBeVisible();
    expect(domainRow.getByText('2 assets')).toBeVisible();
    expect(domainRow.getByText('Daily')).toBeVisible();
    expect(domainRow.getByRole('time')).toHaveAttribute(
      'datetime',
      domain.lastDiscoveredAt,
    );
    expect(domainRow.getByRole('time')).toHaveTextContent(/202[56] \d{2}:\d{2}/);

    const organizationRow = within(
      screen.getByRole('row', { name: /github\.com\/argus-test/ }),
    );
    expect(organizationRow.getByText('1 repository')).toBeVisible();
    expect(organizationRow.getByText('Never')).toBeVisible();
    expect(organizationRow.getByText('Manual')).toBeVisible();
  });

  it('shows empty state when no targets', async () => {
    server.use(
      http.get('/api/targets', () => {
        return HttpResponse.json({
          data: [],
          total: 0,
          page: 1,
          totalPages: 0,
        });
      }),
    );

    renderWithProviders(<Targets />, {
      routePath: '/_authed/targets/',
      initialEntries: ['/_authed/targets/'],
    });

    await waitFor(() => {
      expect(screen.getByText('No data')).toBeInTheDocument();
    });
  });

  it('handles search/filter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Targets />, {
      routePath: '/_authed/targets/',
      initialEntries: ['/_authed/targets/'],
    });

    await waitFor(() => {
      expect(screen.getByText('example.com')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search');
    await user.type(searchInput, 'example');

    await waitFor(() => {
      expect(searchInput).toHaveValue('example');
    });
  });
});
