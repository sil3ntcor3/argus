import Runs from '@/pages/jobs-registry/runs';
import { server } from '@/test/mocks/node';
import { renderWithProviders, screen } from '@/test/utils';
import { within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    hasPermission: (key: string) => key === 'job.read',
    isLoading: false,
  }),
}));

const id = '78e4123e-b6da-4b51-ad3c-8c76eaa83b03';
const name = 'Scan from an older workflow';
const reason = 'Scanner returned <b>invalid output</b>';

it.each([
  { failureReason: reason, activeJobsCount: 0, visible: true },
  { failureReason: null, activeJobsCount: 0, visible: false },
  { failureReason: reason, activeJobsCount: 1, visible: false },
])(
  'renders a failure summary only for a settled run with a message',
  async ({ failureReason, activeJobsCount, visible }) => {
    server.use(
      http.get('/api/jobs-registry/histories/' + id, () =>
        HttpResponse.json({
          id,
          jobHistoryName: name,
          createdAt: '2026-11-09T00:00:00Z',
          updatedAt: '2026-11-09T00:01:00Z',
          tools: [],
          steps: [],
          activeJobsCount,
          failureReason,
        }),
      ),
      http.get('/api/jobs-registry', () =>
        HttpResponse.json({ data: [], page: 1, limit: 10, total: 0 }),
      ),
    );
    renderWithProviders(<Runs />, {
      routePath: '/jobs/runs/$id',
      initialEntries: ['/jobs/runs/' + id],
    });

    await screen.findByText(name);
    if (visible) {
      const summary = within(screen.getByRole('alert'));
      expect(summary.getByText('Latest job failure')).toBeVisible();
      expect(summary.getByText(reason)).toBeVisible();
    } else {
      expect(screen.queryByText('Latest job failure')).not.toBeInTheDocument();
    }
  },
);
