import { server } from '@/test/mocks/node';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectArchiveDialog } from './project-archive-dialog';

const project = {
  id: '304c490a-92da-4d65-a2fd-ecc1437704fb',
  name: 'Perimeter',
  archivedAt: null,
};
const archived = { ...project, archivedAt: '2026-11-13T00:00:00Z' };
let client: QueryClient;
function show(
  value = project as { id: string; name: string; archivedAt: string | null },
) {
  return render(
    <QueryClientProvider client={client}>
      <ProjectArchiveDialog project={value} workspaceId="fixture" />
    </QueryClientProvider>,
  );
}
function open(label = 'Archive project') {
  fireEvent.click(screen.getByRole('button', { name: `${label} Perimeter` }));
  return within(screen.getByRole('dialog', { name: label }));
}
describe('Project archive confirmation', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setGlobalWorkspaceId('fixture');
  });
  afterEach(() => {
    client.clear();
    setGlobalWorkspaceId(null);
    vi.restoreAllMocks();
  });
  it.each([false, true])(
    'confirms and scopes the requested transition, archived=%s',
    async (isArchived) => {
      const write = vi.fn();
      server.use(
        http.post(
          `/api/projects/:id/${isArchived ? 'unarchive' : 'archive'}`,
          ({ request }) => {
            write(request.headers.get('X-Workspace-Id'));
            return HttpResponse.json(isArchived ? project : archived);
          },
        ),
      );
      show(isArchived ? archived : project);
      const label = isArchived ? 'Reopen project' : 'Archive project';
      const dialog = open(label);
      expect(write).not.toHaveBeenCalled();
      fireEvent.click(dialog.getByRole('button', { name: label }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(write).toHaveBeenCalledExactlyOnceWith('fixture');
    },
  );
  it('blocks duplicate submissions and refuses offline writes', async () => {
    const write = vi.fn();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.post('/api/projects/:id/archive', async () => {
        write();
        await pending;
        return HttpResponse.json(archived);
      }),
    );
    show();
    const dialog = open();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent.click(dialog.getByRole('button', { name: 'Archive project' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('offline');
    expect(write).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    fireEvent.click(dialog.getByRole('button', { name: 'Archive project' }));
    fireEvent.click(
      dialog.getByRole('button', { name: /Saving|Archive project/ }),
    );
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('does not replay an ambiguous write across remounts, and rechecks the saved state', async () => {
    const write = vi.fn(),
      read = vi.fn();
    server.use(
      http.post('/api/projects/:id/archive', () => {
        write();
        return HttpResponse.json({}, { status: 502 });
      }),
      http.get('/api/projects/:id', ({ request }) => {
        read(request.headers.get('X-Workspace-Id'));
        return HttpResponse.json(archived);
      }),
    );
    const first = show();
    let dialog = open();
    fireEvent.click(dialog.getByRole('button', { name: 'Archive project' }));
    await dialog.findByText(/Could not confirm the saved/);
    first.unmount();
    show();
    dialog = open();
    expect(
      dialog.queryByRole('button', { name: 'Archive project' }),
    ).toBeNull();
    fireEvent.click(
      dialog.getByRole('button', { name: 'Check project state' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledExactlyOnceWith('fixture');
  });
  it('allows an explicit idempotent retry after checking an unchanged saved state', async () => {
    server.use(
      http.post('/api/projects/:id/archive', () =>
        HttpResponse.json({}, { status: 502 }),
      ),
      http.get('/api/projects/:id', () => HttpResponse.json(project)),
    );
    show();
    const dialog = open();
    fireEvent.click(dialog.getByRole('button', { name: 'Archive project' }));
    await dialog.findByText(/Could not confirm the saved/);
    fireEvent.click(
      dialog.getByRole('button', { name: 'Check project state' }),
    );
    await dialog.findByText(/saved project state is unchanged/);
    expect(
      dialog.getByRole('button', { name: 'Archive project' }),
    ).toBeEnabled();
  });
  it('blocks a write after the workspace changes', () => {
    const write = vi.fn();
    server.use(
      http.post('/api/projects/:id/archive', () => {
        write();
        return HttpResponse.json(archived);
      }),
    );
    show();
    const dialog = open();
    setGlobalWorkspaceId('different');
    fireEvent.click(dialog.getByRole('button', { name: 'Archive project' }));
    expect(write).not.toHaveBeenCalled();
  });
});
