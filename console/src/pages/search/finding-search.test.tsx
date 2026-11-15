import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/node';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import Search from './search';
import { CommandPalette } from '@/components/common/command-palette';

const access = vi.hoisted(() => ({
  value: {
    workspace: 'ws-search',
    finding: true,
    base: true,
    refreshing: false,
    error: null as Error | null,
  },
  listeners: new Set<() => void>(),
}));
vi.mock('@/hooks/usePermission', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    usePermission: () => {
      const state = useSyncExternalStore(
        (listener) => {
          access.listeners.add(listener);
          return () => access.listeners.delete(listener);
        },
        () => access.value,
      );
      return {
        hasPermission: (key: string) =>
          key.startsWith('vulnerability.') ? state.finding : state.base,
        isLoading: false,
        isFetching: state.refreshing,
        error: state.error,
        refetch: vi.fn(),
      };
    },
  };
});
vi.mock('@/hooks/useWorkspaceSelector', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useWorkspaceState: () => {
      const state = useSyncExternalStore(
        (listener) => {
          access.listeners.add(listener);
          return () => access.listeners.delete(listener);
        },
        () => access.value,
      );
      return { state: { selectedWorkspaceId: state.workspace } };
    },
  };
});
vi.mock('@/utils/authClient', () => ({
  useSession: () => ({ data: { user: { role: 'user' } } }),
}));
vi.mock('@/components/common/layout/menu-bar', () => ({
  menu: [],
  getVisibleNavGroups: () => [],
}));

const finding = {
  id: 'finding-search-1',
  name: 'Argus login finding',
  severity: 'high',
  affectedUrl: null,
  asset: { id: 'asset-search-1', value: 'api.example.test' },
};
const response = {
  data: {
    targets: [{ id: 'target-search-1', value: 'example.test' }],
    assets: [],
    vulnerabilities: [finding],
  },
  total: 1,
  page: 1,
  limit: 10,
  pageCount: 1,
  hasNextPage: false,
};
// cmdk measures its list; jsdom supplies no native ResizeObserver.
beforeAll(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterAll(() => vi.unstubAllGlobals());
let calls: URL[];
function changeAccess(partial: Partial<typeof access.value>) {
  act(() => {
    access.value = { ...access.value, ...partial };
    access.listeners.forEach((listener) => listener());
  });
}
function mount(url = '/search?query=login', palette = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const root = createRootRoute({
    component: () => (
      <>
        {palette && <CommandPalette />}
        <Outlet />
      </>
    ),
  });
  const authed = createRoute({ getParentRoute: () => root, id: '_authed' });
  const search = createRoute({
    getParentRoute: () => authed,
    path: 'search',
    component: Search,
    validateSearch: (input: Record<string, unknown>) => ({
      query: typeof input.query === 'string' ? input.query : '',
    }),
  });
  const destination = createRoute({
    getParentRoute: () => authed,
    path: 'vulnerabilities/$id',
    component: () => <p>Finding destination</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([authed.addChildren([search, destination])]),
    history: createMemoryHistory({ initialEntries: [url] }),
    defaultPendingMinMs: 0,
  });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router, queryClient };
}
beforeEach(() => {
  access.value = {
    workspace: 'ws-search',
    finding: true,
    base: true,
    refreshing: false,
    error: null,
  };
  setGlobalWorkspaceId('ws-search');
  calls = [];
  server.use(
    http.get('/api/search', ({ request }) => {
      calls.push(new URL(request.url));
      return HttpResponse.json(response);
    }),
    http.get('/api/search/histories', () =>
      HttpResponse.json({
        data: [],
        total: 0,
        page: 1,
        pageCount: 0,
        hasNextPage: false,
      }),
    ),
  );
});

describe('Finding search page', () => {
  it('shows safe finding previews separately from target/asset totals and opens their detail', async () => {
    const { user, router } = mount();
    const link = await screen.findByRole('link', {
      name: /Argus login finding/,
    });
    expect(screen.getByText('api.example.test')).toBeVisible();
    expect(screen.getByRole('tab', { name: /Findings/ })).toBeVisible();
    expect(screen.getByText(/1 target and asset result/)).toBeVisible();
    await user.click(link);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        '/vulnerabilities/finding-search-1',
      ),
    );
  });
  it('parses repeated severity and CVE shortcuts without losing the original query URL', async () => {
    const raw = 'severity:high severity:critical cve:CVE-2026';
    const { router } = mount('/search?query=' + encodeURIComponent(raw));
    await screen.findByRole('link', { name: /Argus login finding/ });
    expect(calls[0].searchParams.get('value')).toBe('CVE-2026');
    expect(calls[0].searchParams.getAll('severity')).toEqual([
      'high',
      'critical',
    ]);
    expect(router.state.location.search.query).toBe(raw);
  });
  it('keeps the required empty value in a severity-only request despite the shared client cleaner', async () => {
    mount('/search?query=severity%3Acritical');
    await screen.findByRole('link', { name: /Argus login finding/ });
    expect(calls[0].searchParams.has('value')).toBe(true);
    expect(calls[0].searchParams.get('value')).toBe('');
    expect(calls[0].searchParams.getAll('severity')).toEqual(['critical']);
  });
  it('does not submit an empty text shortcut and recovers when a value is added', async () => {
    const { user } = mount('/search?query=host%3A');
    await screen.findByText(
      'Enter a query to search targets, assets and findings.',
    );
    const submit = screen.getByRole('button', { name: 'Search' });
    expect(submit).toBeDisabled();
    expect(calls).toEqual([]);
    await user.type(
      screen.getByRole('textbox', { name: 'Search query' }),
      'api',
    );
    await user.click(submit);
    await screen.findByRole('link', { name: /Argus login finding/ });
    expect(calls.at(-1)?.searchParams.get('value')).toBe('api');
  });
  it('updates severity in the query URL and resets the page on a new filter', async () => {
    const { user, router } = mount('/search?query=login%20severity%3Ahigh');
    const filter = await screen.findByRole('combobox', {
      name: 'Filter findings by severity',
    });
    await user.selectOptions(filter, 'critical');
    await waitFor(() =>
      expect(router.state.location.search.query).toBe(
        'login severity:critical',
      ),
    );
    await waitFor(() =>
      expect(
        calls.some((call) => call.searchParams.get('severity') === 'critical'),
      ).toBe(true),
    );
    expect(screen.getByRole('textbox', { name: 'Search query' })).toHaveValue(
      'login severity:critical',
    );
  });
  it('has an explicit empty finding state while retaining target results', async () => {
    server.use(
      http.get('/api/search', () =>
        HttpResponse.json({
          ...response,
          data: { ...response.data, vulnerabilities: [] },
        }),
      ),
    );
    const { user } = mount();
    await screen.findByRole('link', { name: 'example.test' });
    await user.click(screen.getByRole('tab', { name: /Findings/ }));
    expect(screen.getByText('No matching finding previews.')).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'example.test' }),
    ).not.toBeInTheDocument();
  });
  it('hides finding content and controls without access even if a response includes it', async () => {
    access.value.finding = false;
    mount();
    await screen.findByRole('link', { name: 'example.test' });
    expect(screen.queryByText('Argus login finding')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /Findings/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Filter findings by severity' }),
    ).not.toBeInTheDocument();
  });
  it('does not issue a denied severity request while retaining the editable query', async () => {
    access.value.finding = false;
    const { user } = mount('/search?query=severity%3Acritical');
    expect(
      await screen.findByText(
        'Finding filters require vulnerability read access.',
      ),
    ).toBeVisible();
    const submit = screen.getByRole('button', { name: 'Search' });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(calls).toEqual([]);
    const input = screen.getByRole('textbox', { name: 'Search query' });
    expect(input).toHaveValue('severity:critical');
    await user.clear(input);
    await user.type(input, 'login');
    await user.click(submit);
    expect(
      await screen.findByRole('link', { name: 'example.test' }),
    ).toBeVisible();
    expect(screen.queryByText('Argus login finding')).not.toBeInTheDocument();
  });
  it('removes cached finding content immediately while permissions refresh or are revoked', async () => {
    mount();
    await screen.findByRole('link', { name: /Argus login finding/ });
    changeAccess({ refreshing: true });
    expect(screen.queryByText('Argus login finding')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    changeAccess({ refreshing: false, finding: false });
    await screen.findByRole('link', { name: 'example.test' });
    expect(screen.queryByText('Argus login finding')).not.toBeInTheDocument();
  });
  it('hides stale results after a server denial and does not automatically retry', async () => {
    let count = 0;
    server.use(
      http.get('/api/search', () => {
        count++;
        return new HttpResponse(null, { status: 403 });
      }),
    );
    mount();
    expect(await screen.findByText(/Search is unavailable/)).toBeVisible();
    expect(screen.queryByText('Argus login finding')).not.toBeInTheDocument();
    expect(count).toBe(1);
  });
  it('recovers from an error through the existing Retry control', async () => {
    let count = 0;
    server.use(
      http.get('/api/search', () =>
        ++count === 1
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json(response),
      ),
    );
    const { user } = mount();
    await screen.findByText(/Search is unavailable/);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('link', { name: /Argus login finding/ }),
    ).toBeVisible();
    expect(count).toBe(2);
  });
});

describe('Finding command palette', () => {
  async function open() {
    const result = mount('/search', true);
    const trigger = await screen.findByRole('button', {
      name: 'Open command palette',
    });
    trigger.focus();
    await result.user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', {
      name: 'Command palette',
    });
    return {
      ...result,
      trigger,
      dialog,
      input: within(dialog).getByRole('combobox'),
    };
  }
  it('supports finding keyboard selection and closes on navigation', async () => {
    const { user, router, dialog, input } = await open();
    await user.type(input, 'login');
    const item = await within(dialog).findByRole('option', {
      name: /Argus login finding/,
    });
    await user.keyboard('{Home}{ArrowDown}');
    expect(item).toHaveAttribute('data-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        '/vulnerabilities/finding-search-1',
      ),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('preserves Escape focus return and clears its query on reopening', async () => {
    const { user, trigger, dialog, input } = await open();
    await user.type(input, 'login');
    await within(dialog).findByRole('option', { name: /Argus login finding/ });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard('{Control>}k{/Control}');
    expect(
      within(await screen.findByRole('dialog')).getByRole('combobox'),
    ).toHaveValue('');
  });
  it('hides cached findings while new text is waiting for debounce', async () => {
    const { user, dialog, input } = await open();
    await user.type(input, 'login');
    await within(dialog).findByRole('option', { name: /Argus login finding/ });
    await user.type(input, 'x');
    expect(
      within(dialog).queryByText('Argus login finding'),
    ).not.toBeInTheDocument();
  });
  it('parses severity-only palette queries and preserves their empty value', async () => {
    const { user, dialog, input } = await open();
    await user.type(input, 'severity:critical');
    await within(dialog).findByRole('option', { name: /Argus login finding/ });
    expect(calls.at(-1)?.searchParams.get('value')).toBe('');
    expect(calls.at(-1)?.searchParams.getAll('severity')).toEqual(['critical']);
  });
  it('independently suppresses finding previews during permission refresh and workspace changes', async () => {
    const { user, dialog, input } = await open();
    await user.type(input, 'login');
    await within(dialog).findByRole('option', { name: /Argus login finding/ });
    changeAccess({ refreshing: true });
    expect(
      within(dialog).queryByText('Argus login finding'),
    ).not.toBeInTheDocument();
    server.use(
      http.get('/api/search', async () => {
        await delay(100);
        return HttpResponse.json({
          ...response,
          data: { ...response.data, vulnerabilities: [] },
        });
      }),
    );
    setGlobalWorkspaceId('ws-other');
    changeAccess({ refreshing: false, workspace: 'ws-other' });
    expect(
      within(dialog).queryByText('Argus login finding'),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).queryByText('Argus login finding'),
      ).not.toBeInTheDocument(),
    );
  });
});
