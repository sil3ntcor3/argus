import JobsRegistryPage from '@/pages/jobs-registry/jobs-registry';
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

it('shows settled progress and failures without inventing older run data', async () => {
  const row = {
    totalJobs: 5,
    createdAt: '2026-11-09T00:00:00Z',
    updatedAt: '2026-11-09T00:05:00Z',
    jobRunType: 'manual',
    status: 'pending',
  };
  server.use(
    http.get('/api/jobs-registry/histories', () =>
      HttpResponse.json({
        data: [
          {
            ...row,
            id: 'mixed',
            jobHistoryName: 'Mixed run',
            progress: 80,
            failedJobs: 1,
          },
          {
            ...row,
            id: 'queued',
            jobHistoryName: 'Queued run',
            progress: 0,
            failedJobs: 0,
          },
          { ...row, id: 'legacy', jobHistoryName: 'Older response' },
        ],
        page: 1,
        limit: 10,
        total: 3,
      }),
    ),
  );

  renderWithProviders(<JobsRegistryPage />, { routePath: '/jobs' });

  const mixed = within(await screen.findByRole('row', { name: /Mixed run/ }));
  const mixedBar = mixed.getByRole('progressbar', { name: 'Run progress' });
  expect(mixedBar).toHaveAttribute('aria-valuenow', '80');
  expect(mixedBar).toHaveAttribute('aria-valuetext', '80%, 1 failed job');
  expect(mixed.getByText('1 failed')).toBeVisible();

  const queued = within(screen.getByRole('row', { name: /Queued run/ }));
  expect(queued.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

  const legacy = within(screen.getByRole('row', { name: /Older response/ }));
  expect(legacy.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(legacy.getByText('Run progress unavailable')).toHaveClass('sr-only');
  expect(legacy.getByText('—')).toHaveAttribute('aria-hidden', 'true');
});
