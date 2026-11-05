import { QueryClient } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { hashWorkspaceQueryKey, setGlobalWorkspaceId } from '@/utils/workspaceState';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import Dashboard from '@/pages/dashboard/dashboard';
import { server } from '@/test/mocks/node';
import { http, HttpResponse } from 'msw';

vi.mock('@/utils/authClient', () => ({
  useSession: () => ({
    data: { user: { id: 'user-1', email: 'admin@test.com', name: 'Test Admin', role: 'admin' } },
    isPending: false,
    error: null,
  }),
  authClient: {
    getSession: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
    signIn: { email: vi.fn() },
    signOut: vi.fn(),
    admin: {},
  },
  isVoluntaryLogout: false,
  markVoluntaryLogout: vi.fn(),
  resetVoluntaryLogout: vi.fn(),
}));

vi.mock('recharts', () => {
  const Mock = () => <div />;
  const MockWithChildren = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  const SvgWithChildren = ({ children }: { children?: React.ReactNode }) => (
    <svg>{children}</svg>
  );
  return {
    ResponsiveContainer: MockWithChildren,
    AreaChart: SvgWithChildren,
    Area: Mock,
    LineChart: SvgWithChildren,
    Line: Mock,
    CartesianGrid: Mock,
    XAxis: Mock,
    YAxis: Mock,
    Tooltip: Mock,
    Legend: Mock,
    PieChart: MockWithChildren,
    Pie: Mock,
    Cell: Mock,
  };
});

vi.mock('echarts-for-react/esm/core', () => ({
  default: () => <div />,
}));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TileLayer: () => <div />,
  CircleMarker: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Popup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GeoJSON: () => <div />,
}));

vi.mock('leaflet', () => ({
  default: {},
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ChartTooltip: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ChartTooltipContent: () => <div />,
}));

vi.mock('@/components/ui/data-table', () => ({
  DataTable: () => <div />,
}));

vi.mock('@/pages/dashboard/components/statistic', () => ({
  default: () => (
    <div>
      <span>Targets</span>
      <span>Assets</span>
      <span>Services</span>
      <span>Technologies</span>
    </div>
  ),
}));

describe('Dashboard Page', () => {
  it('renders dashboard title', async () => {
    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });
  });

  it('shows create workspace when no workspaces exist', async () => {
    server.use(
      http.get('/api/workspaces', () => {
        return HttpResponse.json({ data: [] });
      }),
    );

    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByText('Create a new workspace'),
      ).toBeInTheDocument();
    });
  });

  it('renders statistics cards', async () => {
    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      expect(screen.getAllByText('Targets').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Assets').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Services').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Technologies').length).toBeGreaterThanOrEqual(1);
    });
  });
});

const workspaceA = '03b48db5-e64e-4305-afec-a21143f5e866';
const workspaceB = '91bc0194-7f83-441a-b8d9-02479f3c5a39';

/** Exercise the real generated hook, Axios tenant header and workspace cache. */
describe('Dashboard asset-location workspace lifecycle', () => {
  beforeEach(() => {
    setGlobalWorkspaceId(null);
    server.use(
      http.get('/api/workspaces/current-permission', () =>
        HttpResponse.json({ currentPermission: ['*'] }),
      ),
    );
  });
  afterEach(() => setGlobalWorkspaceId(null));

  const renderDashboard = () =>
    renderWithProviders(<Dashboard />, {
      queryClient: new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            queryKeyHashFn: hashWorkspaceQueryKey,
          },
        },
      }),
    });
  const captureLocations = () => {
    const requests: (string | null)[] = [];
    server.use(
      http.get('/api/statistic/asset-locations', ({ request }) => {
        const workspace = request.headers.get('X-Workspace-Id');
        requests.push(workspace);
        if (!workspace)
          return HttpResponse.json(
            { message: 'Workspace ID not provided in headers' },
            { status: 403 },
          );
        return HttpResponse.json(
          workspace === workspaceA
            ? [{ countryCode: 'CA', country: 'Canada', count: 3 }]
            : [{ countryCode: 'DE', country: 'Germany', count: 7 }],
        );
      }),
    );
    return requests;
  };

  it('does not request locations for a new account without a workspace', async () => {
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json({ data: [] })),
    );
    const requests = captureLocations();
    const { queryClient } = renderDashboard();
    await screen.findByText('Create a new workspace');
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(requests).toEqual([]);
  });

  it('waits while the workspace list loads instead of making a headerless request', async () => {
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = vi.fn();
    server.use(
      http.get('/api/workspaces', async () => {
        started();
        await loading;
        return HttpResponse.json({ data: [] });
      }),
    );
    const requests = captureLocations();
    const { queryClient } = renderDashboard();
    try {
      await waitFor(() => expect(started).toHaveBeenCalled());
      expect(requests).toEqual([]);
    } finally {
      release();
    }
    await screen.findByText('Create a new workspace');
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(requests).toEqual([]);
  });

  it('starts the query with the tenant header when selection becomes available', async () => {
    server.use(
      http.get('/api/workspaces', () =>
        HttpResponse.json({ data: [{ id: workspaceA, name: 'Workspace A' }] }),
      ),
    );
    const requests = captureLocations();
    const { queryClient } = renderDashboard();
    await screen.findByText('Top exposed ports');
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(requests).toEqual([]);
    act(() => setGlobalWorkspaceId(workspaceA));
    await screen.findByText('Canada');
    expect(requests).toEqual([workspaceA]);
  });

  it('keeps map data scoped on switches and stops fetching when selection is cleared', async () => {
    server.use(
      http.get('/api/workspaces', () =>
        HttpResponse.json({
          data: [
            { id: workspaceA, name: 'Workspace A' },
            { id: workspaceB, name: 'Workspace B' },
          ],
        }),
      ),
    );
    const requests = captureLocations();
    setGlobalWorkspaceId(workspaceA);
    const { queryClient } = renderDashboard();
    await screen.findByText('Canada');
    act(() => setGlobalWorkspaceId(workspaceB));
    await screen.findByText('Germany');
    expect(screen.queryByText('Canada')).not.toBeInTheDocument();
    expect(requests).toEqual([workspaceA, workspaceB]);
    act(() => setGlobalWorkspaceId(null));
    await queryClient.invalidateQueries({
      queryKey: ['/api/statistic/asset-locations'],
    });
    expect(requests).toEqual([workspaceA, workspaceB]);
  });
});
