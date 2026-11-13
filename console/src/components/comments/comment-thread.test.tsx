import { act, fireEvent, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/mocks/node';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import type { CommentResponseDto } from '@/services/apis/gen/queries';
import { CommentThread } from './comment-thread';

const permission = vi.hoisted(() => ({ read: true, write: true, version: 0, listeners: new Set<() => void>() }));
vi.mock('@/hooks/usePermission', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => { permission.listeners.add(listener); return () => { permission.listeners.delete(listener); }; };
  return { usePermission: () => {
    useSyncExternalStore(subscribe, () => permission.version);
    return { hasPermission: (key: string) => key.endsWith('.write') ? permission.write : permission.read,
      isFetching: false, isLoading: false };
  } };
});
vi.mock('@/utils/authClient', () => ({ useSession: () => ({ data: { user: { id: 'viewer', name: 'Viewer' } } }) }));
const endpoint = '/api/vulnerabilities/finding/comments';
const subject = { type: 'vulnerability', id: 'finding' } as const;
const row = (id: string, content: string, author = 'viewer'): CommentResponseDto => ({
  id, content, type: 'content', issueId: null, vulnerabilityId: 'finding', isCanEdit: true, isCanDelete: true,
  createdAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-01T12:00:00Z',
  author: { id: author, name: author === 'viewer' ? 'Viewer' : 'Peer', image: null }, repComment: null,
});
const page = (data: CommentResponseDto[]) => ({ data, page: 1, limit: 100, total: data.length, hasNextPage: false });

function renderThread(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })) {
  return renderWithProviders(<CommentThread subject={subject} />, { queryClient: client });
}

describe('Resource discussion thread', () => {
  let rows: CommentResponseDto[];
  let deleted: Set<string>;
  let writes: { method: string; body?: Record<string, unknown> }[];
  beforeEach(() => {
    permission.read = true; permission.write = true; rows = []; deleted = new Set(); writes = [];
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    setGlobalWorkspaceId('A');
    server.use(
      http.get(endpoint, () => HttpResponse.json(page(rows.filter(item => !deleted.has(item.id)).map(item => ({
        ...item, repComment: item.repComment && deleted.has(item.repComment.id)
          ? { ...item.repComment, deleted: true, snippet: '' } : item.repComment,
      }))))),
      http.post(endpoint, async ({ request }) => {
        const body = await request.json() as { content: string; repCommentId?: string };
        writes.push({ method: 'POST', body });
        const saved = row(String(rows.length + 1), body.content);
        const parent = rows.find(item => item.id === body.repCommentId);
        if (parent) saved.repComment = { id: parent.id, snippet: parent.content, deleted: false, author: parent.author };
        rows.push(saved); return HttpResponse.json(saved, { status: 201 });
      }),
      http.patch('/api/comments/:id', async ({ request, params }) => {
        const body = await request.json() as { content: string };
        writes.push({ method: 'PATCH', body });
        const saved = rows.find(item => item.id === params.id)!; saved.content = body.content;
        return HttpResponse.json(saved);
      }),
      http.delete('/api/comments/:id', ({ params }) => {
        writes.push({ method: 'DELETE' }); deleted.add(String(params.id));
        return HttpResponse.json({ message: 'Comment deleted successfully' });
      }),
    );
  });
  afterEach(() => {
    act(() => setGlobalWorkspaceId(null));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('posts, replies, edits and deletes without rendering user text as HTML', async () => {
    const { user } = renderThread();
    await screen.findByText('No comments yet.');
    const composer = screen.getByRole('textbox', { name: 'Comment' });
    expect(composer).toHaveAttribute('maxlength', '10000');
    await user.type(composer, '<img src=x onerror=alert(1)>');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(composer).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(composer, 'Reply body');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    await screen.findByText('Reply body');
    expect(writes[1]).toEqual({ method: 'POST', body: { content: 'Reply body', repCommentId: '1' } });
    const first = within(screen.getAllByTestId('comment-item')[0]);
    await user.type(composer, 'Keep this unrelated draft');
    await user.click(first.getByRole('button', { name: 'Edit comment' }));
    const editor = screen.getByRole('textbox', { name: 'Edit comment text' });
    await user.clear(editor); await user.type(editor, 'Updated parent');
    await user.click(screen.getByRole('button', { name: 'Save comment' }));
    await screen.findByText('Updated parent');
    await waitFor(() => expect(composer).not.toBeDisabled());
    expect(composer).toHaveValue('Keep this unrelated draft');
    await user.click(first.getByRole('button', { name: 'Delete comment' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Original comment deleted');
    await waitFor(() => expect(composer).not.toBeDisabled());
    expect(composer).toHaveValue('Keep this unrelated draft');
    expect(screen.queryByText('Updated parent')).not.toBeInTheDocument();
    expect(writes.map(item => item.method)).toEqual(['POST', 'POST', 'PATCH', 'DELETE']);
  });

  it('respects read-only access, authorship, system flags and deleted authors', async () => {
    rows = [row('1', 'Owned'), row('2', 'Peer comment', 'peer'), { ...row('3', 'System'), isCanEdit: false, isCanDelete: false },
      { ...row('4', 'Deleted author'), author: null }];
    renderThread();
    await screen.findByText('Peer comment');
    expect(screen.getAllByRole('button', { name: 'Edit comment' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete comment' })).toHaveLength(1);
    act(() => { permission.write = false; permission.version++; permission.listeners.forEach(listener => listener()); });
    expect(screen.getByText('Read-only discussion.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
    act(() => { permission.read = false; permission.version++; permission.listeners.forEach(listener => listener()); });
    expect(screen.queryByText('Peer comment')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('do not have access');
  });

  it('loads pages and retries a failed initial read before allowing writes', async () => {
    let failed = true;
    server.use(http.get(endpoint, ({ request }) => {
      if (failed) return new HttpResponse(null, { status: 503 });
      const pageNumber = Number(new URL(request.url).searchParams.get('page'));
      return HttpResponse.json({ ...page([row(String(pageNumber), 'Page ' + pageNumber)]),
        page: pageNumber, total: 2, hasNextPage: pageNumber === 1 });
    }));
    const { user } = renderThread();
    await screen.findByText('Unable to load comments.');
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    failed = false; await user.click(screen.getByRole('button', { name: 'Retry comments' }));
    await screen.findByText('Page 1');
    await user.click(screen.getByRole('button', { name: 'Load more comments' }));
    await screen.findByText('Page 2');
    expect(screen.queryByRole('button', { name: 'Load more comments' })).not.toBeInTheDocument();
  });

  it('blocks offline writes and duplicate submits without replaying on reconnect', async () => {
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    server.use(http.post(endpoint, async () => { writes.push({ method: 'POST' }); await response;
      return HttpResponse.json(row('1', 'One submission'), { status: 201 }); }));
    const { user } = renderThread();
    await screen.findByText('No comments yet.');
    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'One submission');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(writes).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Reconnect');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    fireEvent(window, new Event('online'));
    expect(writes).toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Comment' });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(writes).toHaveLength(1));
    release(); await waitFor(() => expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue(''));
  });

  it('retains unknown creates after partial reads and requires explicit discard before a new draft', async () => {
    rows = Array.from({ length: 100 }, (_, index) => ({ ...row(String(index), 'Earlier ' + index), type: 'open' as const }));
    server.use(http.get(endpoint, ({ request }) => {
      const pageNumber = Number(new URL(request.url).searchParams.get('page'));
      return HttpResponse.json({ ...page(rows.slice((pageNumber - 1) * 100, pageNumber * 100)),
        page: pageNumber, total: rows.length, hasNextPage: pageNumber * 100 < rows.length });
    }));
    server.use(http.post(endpoint, async ({ request }) => {
      const body = await request.json() as { content: string };
      rows.push(row('101', body.content)); writes.push({ method: 'POST' });
      return new HttpResponse(null, { status: 502 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = renderThread(client);
    await screen.findByText('Earlier 0');
    await view.user.type(screen.getByRole('textbox', { name: 'Comment' }), 'Saved despite lost response');
    await view.user.click(screen.getByRole('button', { name: 'Comment' }));
    await screen.findByText('Outcome unknown. Check saved comments before trying again.');
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    view.unmount();
    const remount = renderThread(client);
    await screen.findByText('Earlier 0');
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeDisabled();
    await remount.user.click(screen.getByRole('button', { name: 'Check saved comments' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check saved comments' })).not.toBeDisabled());
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeDisabled();
    await remount.user.click(screen.getByRole('button', { name: 'Load more comments' }));
    await screen.findByText('Saved despite lost response');
    await remount.user.click(screen.getByRole('button', { name: 'Discard uncertain submission' }));
    await remount.user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard submission' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Comment' })).not.toBeDisabled());
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('');
    expect(writes).toHaveLength(1);
    client.clear();
  }, 10_000);

  it('isolates workspace drafts and discards a late read after A → B → A', async () => {
    let requests = 0;
    server.use(http.get(endpoint, async ({ request }) => {
      const workspace = request.headers.get('x-workspace-id'); requests++;
      if (requests === 2) await delay(100);
      return HttpResponse.json(page([row(workspace!, 'Thread ' + workspace)]));
    }));
    const { user } = renderThread();
    await screen.findByText('Thread A');
    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'Workspace A draft');
    act(() => setGlobalWorkspaceId('B'));
    expect(screen.queryByText('Thread A')).not.toBeInTheDocument();
    act(() => setGlobalWorkspaceId('A'));
    await screen.findByText('Thread A');
    expect(screen.queryByText('Thread B')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('');
    expect(writes).toHaveLength(0);
  });

  it('keeps the composer locked until the post-save refresh and cleanup finish', async () => {
    let reads = 0;
    let release!: () => void;
    const refresh = new Promise<void>(resolve => { release = resolve; });
    server.use(http.get(endpoint, async () => {
      reads++;
      if (reads > 1) await refresh;
      return HttpResponse.json(page(rows));
    }));
    const { user } = renderThread();
    await screen.findByText('No comments yet.');
    const composer = screen.getByRole('textbox', { name: 'Comment' });
    await user.type(composer, 'Submitted text');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(composer).toBeDisabled();
    release();
    await waitFor(() => expect(composer).not.toBeDisabled());
    expect(composer).toHaveValue('');
    await user.type(composer, 'New unsent text');
    expect(composer).toHaveValue('New unsent text');
  });

  it('restores keyboard focus to the delete control after cancelling its dialog', async () => {
    rows = [row('1', 'Focus fixture')];
    const { user } = renderThread();
    await screen.findByText('Focus fixture');
    const trigger = screen.getByRole('button', { name: 'Delete comment' });
    await user.click(trigger);
    const cancel = within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
