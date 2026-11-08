import { beforeEach, describe, it, expect, vi } from 'vitest';
import { within } from '@testing-library/react';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/node';
import Targets from '@/pages/targets/targets';

const canReadFindings = vi.hoisted(() => vi.fn(() => true));
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
    expect(screen.getByText('Services')).toBeInTheDocument();
    // Type is a badge column; Source is an icon next to the target, not a column
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Domain')).toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
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
