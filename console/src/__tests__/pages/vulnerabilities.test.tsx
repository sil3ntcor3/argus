import { fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import Vulnerabilities from '@/pages/vulnerabilities/vulnerabilities';

const mockStats = vi.hoisted(() => vi.fn());
const mockFindings = vi.hoisted(() => vi.fn());

const mockWorkspaces = [{ id: 'ws-1', name: 'Test Workspace' }];
const mockVulns = [
  {
    id: 'vuln-1',
    name: 'SQL Injection',
    description: 'SQL injection vulnerability',
    severity: 'critical',
    status: 'open',
    tags: [],
    references: [],
    authors: [],
    affectedUrl: 'https://example.com/login',
    ipAddress: '93.184.216.34',
    host: 'example.com',
    ports: ['80'],
    cvssMetric: 'HIGH',
    cvssScore: 9.8,
    epssScore: 0.95,
    vprScore: 9.0,
    cveId: ['CVE-2024-1234'],
    bidId: [],
    cweId: [],
    ceaId: [],
    iava: [],
    cveUrl: '',
    cweUrl: '',
    solution: 'Sanitize inputs',
    extractorName: '',
    extractedResults: [],
    publicationDate: '',
    modificationDate: '',
    firstDetectedDate: '2026-01-01T00:00:00Z',
    lastSeenDate: '2026-01-01T00:00:00Z',
    synopsis: '',
    tool: null,
    asset: { id: 'asset-1', value: 'https://example.com/login' },
    vulnerabilityDismissal: null,
    analyzeStatus: null,
    analyzeResult: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'vuln-2',
    name: 'XSS Vulnerability',
    description: 'Cross-site scripting',
    severity: 'high',
    status: 'open',
    tags: [],
    references: [],
    authors: [],
    affectedUrl: 'https://example.com/search',
    ipAddress: '93.184.216.34',
    host: 'example.com',
    ports: ['443'],
    cvssMetric: 'HIGH',
    cvssScore: 7.5,
    epssScore: 0.8,
    vprScore: 7.0,
    cveId: [],
    bidId: [],
    cweId: [],
    ceaId: [],
    iava: [],
    cveUrl: '',
    cweUrl: '',
    solution: 'Escape output',
    extractorName: '',
    extractedResults: [],
    publicationDate: '',
    modificationDate: '',
    firstDetectedDate: '2026-01-01T00:00:00Z',
    lastSeenDate: '2026-01-01T00:00:00Z',
    synopsis: '',
    tool: null,
    asset: { id: 'asset-1', value: 'https://example.com/search' },
    vulnerabilityDismissal: null,
    analyzeStatus: null,
    analyzeResult: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

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
    hasPermission: () => true,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/services/apis/gen/queries', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/apis/gen/queries')>();
  return {
    ...actual,
    useVulnerabilitiesControllerGetVulnerabilities: mockFindings,
    useVulnerabilitiesControllerGetVulnerabilitiesStatistics: mockStats,
  };
});

describe('Vulnerabilities Page', () => {
  beforeEach(() => {
    mockFindings.mockReset().mockReturnValue({
      data: { data: mockVulns, total: mockVulns.length },
      isLoading: false,
      refetch: vi.fn(),
    });
    mockStats.mockReset().mockReturnValue({
      data: {
        data: [
          { severity: 'critical', count: 1 },
          { severity: 'high', count: 1 },
        ],
      },
      isLoading: false,
    });
  });

  it('preserves calendar dates from a shared URL when the browser is west of UTC', async () => {
    renderWithProviders(<Vulnerabilities />, {
      initialEntries: ['/?createdFrom=2020-01-31&createdTo=2020-01-31'],
    });
    await waitFor(() => expect(mockFindings).toHaveBeenCalledWith(
      expect.objectContaining({ createdFrom: '2020-01-31', createdTo: '2020-01-31' }),
      expect.anything(),
    ));
  });

  it('shows all five severity counts, including severities with no findings', async () => {
    renderWithProviders(<Vulnerabilities />);
    const summary = within(
      await screen.findByLabelText('Finding severity counts'),
    );
    expect(summary.getByText('Critical').nextElementSibling).toHaveTextContent(
      '1',
    );
    expect(summary.getByText('Low').nextElementSibling).toHaveTextContent('0');
    expect(summary.getAllByRole('term')).toHaveLength(5);
  });

  it('lets the user retry a failed initial count request', async () => {
    const refetch = vi.fn();
    mockStats.mockReturnValue({ isError: true, refetch });
    renderWithProviders(<Vulnerabilities />);
    expect(
      await screen.findByText('Unable to load severity counts'),
    ).toBeVisible();
    expect(screen.queryByLabelText('Finding severity counts')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry severity counts' }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders vulnerability table', async () => {
    renderWithProviders(<Vulnerabilities />);

    await waitFor(() => {
      expect(screen.getByText('SQL Injection')).toBeInTheDocument();
      expect(screen.getByText('XSS Vulnerability')).toBeInTheDocument();
    });
  });

  it('shows severity badges', async () => {
    renderWithProviders(<Vulnerabilities />);

    await waitFor(() => {
      const severityBadges = screen.getAllByText('Critical');
      expect(severityBadges.length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('High').length).toBeGreaterThanOrEqual(2);
    });
  });
});
