import type { VulnerabilityTimelineEventDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingTimeline } from './finding-timeline';

const useTimeline = vi.hoisted(() => vi.fn());
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useVulnerabilitiesControllerGetVulnerabilityTimeline: useTimeline,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    'aria-label': label,
    to,
    params,
    children,
  }: {
    to: string;
    params: { id: string };
    children: ReactNode;
    'aria-label'?: string;
  }) => (
    <a href={to.replace('$id', params.id)} aria-label={label}>
      {children}
    </a>
  ),
}));

const events: VulnerabilityTimelineEventDto[] = [
  {
    id: 'second',
    type: 'status_changed',
    occurredAt: '2026-11-03T09:00:00Z',
    fromStatus: 'new',
    toStatus: 'active',
    jobHistoryId: 'run-2',
  },
  {
    id: 'first',
    type: 'detected',
    occurredAt: '2026-11-02T09:00:00Z',
    fromStatus: null,
    toStatus: 'new',
    jobHistoryId: null,
  },
];

function open(canOpenRuns = true) {
  render(
    <FindingTimeline
      id="finding-1"
      name="Open redirect"
      canOpenRuns={canOpenRuns}
    />,
  );
  expect(useTimeline).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
  return within(screen.getByRole('dialog', { name: 'Finding timeline' }));
}

describe('FindingTimeline', () => {
  beforeEach(() => {
    useTimeline
      .mockReset()
      .mockReturnValue({ data: { data: events }, isFetchedAfterMount: true });
  });

  it('loads only when opened and shows the recorded events and allowed run links', () => {
    const dialog = open();
    expect(useTimeline).toHaveBeenCalledWith('finding-1', expect.anything());
    const rows = dialog.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('New → Active');
    expect(rows[1]).toHaveTextContent('First detected');
    expect(rows[0].querySelector('time')).toHaveAttribute(
      'dateTime',
      events[0].occurredAt,
    );
    expect(dialog.getAllByRole('link')).toHaveLength(1);
    expect(
      dialog.getByRole('link', { name: /View run for New → Active/ }),
    ).toHaveAttribute('href', '/jobs/runs/run-2');
  });

  it('keeps events visible but hides run links if job access is lost', () => {
    const dialog = open(false);
    expect(dialog.getByText('New → Active')).toBeVisible();
    expect(dialog.queryByRole('link')).not.toBeInTheDocument();
  });

  it('explains fix claims and distinguishes covering scans begun before or after a claim', () => {
    useTimeline.mockReturnValue({ data: { data: [
      { ...events[1], id: 'claim', type: 'fix_claimed', verification: 'next_covering_scan' },
      { ...events[1], id: 'unknown', type: 'fix_claimed', verification: 'not_verifiable_by_scan' },
      { ...events[0], id: 'verified', toStatus: 'fixed', fixClaimVerified: true },
      { ...events[0], id: 'earlier', toStatus: 'fixed', fixClaimVerified: false },
    ] }, isFetchedAfterMount: true });
    const dialog = open();
    expect(dialog.getByText('Awaiting the next trusted covering scan.')).toBeVisible();
    expect(dialog.getByText(/No comparable scan evidence/)).toBeVisible();
    expect(dialog.getByText('Fix claim verified by a covering scan.')).toBeVisible();
    expect(dialog.getByText('This scan did not verify a fix claim.')).toBeVisible();
  });

  it('describes dismissal history and keeps unknown events neutral', () => {
    useTimeline.mockReturnValue({
      data: {
        data: ['risk_expired', 'reopened', 'dismissed', 'future_event'].map(
          (type) => ({
            ...events[1],
            id: type,
            type,
            fromStatus: null,
            toStatus: null,
          }),
        ),
      },
      isFetchedAfterMount: true,
    });
    const rows = open().getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Risk acceptance expired');
    expect(rows[1]).toHaveTextContent('Reopened');
    expect(rows[2]).toHaveTextContent('Dismissed');
    expect(rows[3]).toHaveTextContent('Finding updated');
  });

  it('shows dismissal reasons and only valid risk acceptance expiries', () => {
    const expiresAt = '2026-11-10T16:30:00Z';
    useTimeline.mockReturnValue({
      data: {
        data: [
          { type: 'risk_expired', dismissalReason: 'risk_accepted', expiresAt },
          { type: 'reopened', dismissalReason: 'wont_fix', expiresAt },
          {
            type: 'dismissed',
            dismissalReason: 'risk_accepted',
            expiresAt: 'invalid',
          },
          { type: 'detected', dismissalReason: 'false_positive' },
        ].map((event, index) => ({
          ...events[1],
          ...event,
          id: String(index),
        })),
      },
      isFetchedAfterMount: true,
    });
    const rows = open().getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Reason: Risk accepted');
    expect(rows[0]).toHaveTextContent('Expiry:');
    expect(
      rows[0].querySelector('time[datetime="' + expiresAt + '"]'),
    ).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Reason: Won't fix");
    expect(rows[1]).not.toHaveTextContent('Expiry:');
    expect(rows[2]).not.toHaveTextContent('Expiry:');
    expect(rows[3]).not.toHaveTextContent('Reason:');
  });

  it('shows a loading state while awaiting events', () => {
    useTimeline.mockReturnValue({
      data: { data: events },
      isFetchedAfterMount: false,
    });
    const dialog = open();
    expect(dialog.getByRole('status')).toHaveTextContent(
      'Loading finding timeline',
    );
    expect(dialog.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the empty state for a successful response without events', () => {
    useTimeline.mockReturnValue({
      data: { data: [] },
      isFetchedAfterMount: true,
    });
    expect(open().getByText('No events yet.')).toBeVisible();
  });

  it('offers a retry without showing cached events when a request fails', () => {
    const refetch = vi.fn();
    useTimeline.mockReturnValue({
      data: { data: events },
      isError: true,
      refetch,
    });
    const dialog = open();
    expect(dialog.getByRole('status')).toHaveTextContent(
      'Unable to load the finding timeline',
    );
    expect(dialog.queryByRole('list')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(
      dialog.getByRole('region', { name: 'Finding timeline results' }),
    ).toHaveFocus();
  });
});
