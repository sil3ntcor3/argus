import { TargetActivityTab } from '@/pages/targets/components/target-activity-tab';
import { server } from '@/test/mocks/node';
import { renderWithProviders, screen } from '@/test/utils';
import { delay, http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';

vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'ws-1' } }),
}));

const id = 'fc4fe245-d9e6-4f68-aef7-a6b4d7757224';
const runsPath = `/api/targets/${id}/runs`;
const completed = {
  id: 'completed-1',
  workflowName: 'Completed discovery',
  status: 'completed',
  jobRunType: 'manual',
  createdAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  jobsTotal: 1,
  jobsDone: 1,
  jobsFailed: 0,
  jobsRunning: 0,
};
const pending = {
  ...completed,
  id: 'pending-1',
  workflowName: 'Pending discovery',
  status: 'pending',
  jobsTotal: 0,
  jobsDone: 0,
};

function show() {
  return renderWithProviders(
    <TargetActivityTab
      targetId={id}
      canReadProjects={false}
      onAccessDenied={vi.fn()}
    />,
  );
}

it('starts at page one when switching between active and full run history', async () => {
  const activePages: string[] = [];
  server.use(
    http.get(runsPath, async ({ request }) => {
      const params = new URL(request.url).searchParams;
      const page = Number(params.get('page'));
      if (params.get('active') === 'true') {
        activePages.push(String(page));
        await delay(150);
        return HttpResponse.json({ page, data: [pending], hasNextPage: false });
      }
      return HttpResponse.json({
        page,
        data:
          page === 1
            ? [completed]
            : [
                {
                  ...completed,
                  id: 'older-1',
                  workflowName: 'Older discovery',
                },
              ],
        hasNextPage: page === 1,
      });
    }),
  );
  const { user } = show();
  expect(await screen.findByText('Completed discovery')).toBeVisible();
  const toggle = screen.getByRole('switch', { name: 'Active runs only' });
  expect(toggle).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Load more runs' }));
  expect(await screen.findByText('Older discovery')).toBeVisible();
  toggle.focus();
  await user.keyboard(' ');
  expect(toggle).toBeChecked();
  expect(screen.queryByText('Older discovery')).not.toBeInTheDocument();
  expect(await screen.findByText('Pending discovery')).toBeVisible();
  expect(screen.getByRole('status', { name: 'Run results' })).toHaveTextContent(
    'Showing 1 active run.',
  );
  expect(activePages).toEqual(['1']);
  expect(toggle).toHaveFocus();
  await user.keyboard(' ');
  expect(toggle).not.toBeChecked();
  expect(await screen.findByText('Completed discovery')).toBeVisible();
  expect(screen.queryByText('Older discovery')).not.toBeInTheDocument();
});

it('distinguishes an empty active page from an empty full history', async () => {
  server.use(
    http.get(runsPath, () =>
      HttpResponse.json({ page: 1, data: [], hasNextPage: false }),
    ),
  );
  const { user } = show();
  expect(await screen.findByText('No runs for this target yet.')).toBeVisible();
  await user.click(screen.getByRole('switch', { name: 'Active runs only' }));
  expect(
    await screen.findByText('No active runs started in the last seven days.'),
  ).toBeVisible();
});
