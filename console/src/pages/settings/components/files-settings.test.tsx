import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FilesSettings from './files-settings';

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  files: vi.fn(),
  folders: vi.fn(),
  folderDetail: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
}));

const owned = { id: 'mine', name: 'My report.txt', isOwner: true };
const peer = { id: 'peer', name: 'Peer report.txt', isOwner: false };

vi.mock('@/hooks/usePermission', () => ({ usePermission: mocks.permission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'workspace' } }),
}));
vi.mock('@/services/apis/gen/queries', async (original) => ({
  ...(await original<typeof import('@/services/apis/gen/queries')>()),
  useArtifactsControllerGetUsage: () => ({}),
  useArtifactsControllerGetMany: mocks.files,
  useArtifactFoldersControllerGetMany: mocks.folders,
  useArtifactFoldersControllerGetById: mocks.folderDetail,
  artifactsControllerDownload: mocks.download,
  artifactsControllerRemove: mocks.remove,
}));

function show(
  permissions: string[],
  url: string | string[] = '/settings/files',
  routePath = '/settings/$tab',
) {
  mocks.permission.mockReturnValue({
    hasPermission: (key: string) => permissions.includes(key),
    refetch: vi.fn(),
  });
  return renderWithProviders(<FilesSettings />, {
    routePath,
    initialEntries: typeof url === 'string' ? [url] : url,
  });
}

describe('Files settings actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download.mockReset();
    mocks.remove.mockReset();
    mocks.folders.mockReturnValue({ isFetchedAfterMount: true, data: [] });
    mocks.folderDetail.mockReturnValue({});
    localStorage.removeItem('argus.files.view');
    const filesByScope: Record<string, (typeof owned)[]> = {
      mine: [owned],
      shared: [peer],
      all: [owned, peer],
    };
    mocks.files.mockImplementation((params: { scope: string }) => ({
      isFetchedAfterMount: true,
      data: {
        data: filesByScope[params.scope].map((file) => ({
          ...file,
          mimeType: 'text/plain',
          sizeBytes: 4,
          source: 'upload',
          createdAt: '2026-01-02T00:00:00Z',
        })),
      },
    }));
    setGlobalWorkspaceId('workspace');
  });

  it('browses personal folders with breadcrumbs and searches across folders', async () => {
    const reports = {
      id: '9045f7b1-483e-4515-84f2-d6ef87259218',
      name: 'Reports',
    };
    const archive = {
      id: 'c34d5c35-3663-433a-ae2e-089f02011c2d',
      name: 'Archive',
    };
    mocks.folders.mockImplementation((params?: { parentFolderId: string }) => ({
      isFetchedAfterMount: true,
      data: !params
        ? [reports]
        : params.parentFolderId === reports.id
          ? [archive]
          : [],
    }));
    mocks.folderDetail.mockImplementation((id: string) => ({
      isFetchedAfterMount: true,
      data: { path: id === archive.id ? [reports, archive] : [reports] },
    }));
    show(['artifact.read', 'artifact.manage']);
    const lastFileFilter = () => mocks.files.mock.lastCall?.[0];
    await waitFor(() =>
      expect(lastFileFilter()).toMatchObject({
        parentFolderId: 'root',
        page: 1,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Reports' }));
    expect(
      screen.getByRole('region', { name: 'Folder navigation' }),
    ).toHaveFocus();
    await waitFor(() =>
      expect(lastFileFilter()).toMatchObject({
        parentFolderId: reports.id,
        page: 1,
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(lastFileFilter()).toMatchObject({
        parentFolderId: archive.id,
        page: 1,
      }),
    );
    const path = screen.getByRole('navigation', { name: 'Folder path' });
    expect(within(path).getByText('Archive')).toHaveAttribute(
      'aria-current',
      'location',
    );
    fireEvent.click(within(path).getByRole('button', { name: 'Reports' }));
    await waitFor(() =>
      expect(lastFileFilter()).toMatchObject({ parentFolderId: reports.id }),
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), {
      target: { value: 'report' },
    });
    await waitFor(() =>
      expect(lastFileFilter()).toMatchObject({
        search: 'report',
        parentFolderId: undefined,
      }),
    );
    expect(
      screen.queryByRole('navigation', { name: 'Folder path' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All files' }));
    expect(lastFileFilter()).toMatchObject({
      scope: 'all',
      parentFolderId: undefined,
    });
  });

  it('opens a folder link and restores it from browser history', async () => {
    const folder = {
      id: '8e27a9a4-3a94-45f2-b9fc-dc5e1c817629',
      name: 'Reports',
    };
    mocks.folderDetail.mockReturnValue({
      isFetchedAfterMount: true,
      data: { path: [folder] },
    });
    mocks.files.mockReturnValue({
      isFetchedAfterMount: true,
      data: {
        data: [
          {
            ...owned,
            mimeType: 'text/plain',
            sizeBytes: 4,
            source: 'upload',
            createdAt: '2026-01-02T00:00:00Z',
          },
        ],
        hasNextPage: true,
      },
    });
    const { router } = show(
      ['artifact.read'],
      [
        '/settings/files?context=fixture',
        `/settings/files?folder=${folder.id.toUpperCase()}&context=fixture`,
      ],
    );
    const path = await screen.findByRole('navigation', { name: 'Folder path' });
    expect(within(path).getByText('Reports')).toHaveAttribute(
      'aria-current',
      'location',
    );
    expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
      parentFolderId: folder.id,
      page: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
      parentFolderId: folder.id,
      page: 2,
    });
    await act(async () => {
      router.history.back();
    });
    await waitFor(() =>
      expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
        parentFolderId: 'root',
        page: 1,
      }),
    );
    await act(async () => {
      router.history.forward();
    });
    await waitFor(() =>
      expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
        parentFolderId: folder.id,
        page: 1,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Root folder' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ context: 'fixture' }),
    );
    await act(async () => {
      router.history.back();
    });
    await waitFor(() =>
      expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
        parentFolderId: folder.id,
        page: 1,
      }),
    );
  });

  it('can render at the settings index and ignores an invalid folder value', async () => {
    show(['artifact.read'], '/settings?folder=invalid', '/settings');
    await waitFor(() =>
      expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
        parentFolderId: 'root',
      }),
    );
    expect(mocks.folderDetail).not.toHaveBeenCalledWith(
      'invalid',
      expect.anything(),
    );
  });

  it('sends the selected sort to the server and resets pagination', async () => {
    const updatedAt = '2026-02-03T00:00:00Z';
    mocks.files.mockReturnValue({
      isFetchedAfterMount: true,
      data: {
        data: [
          {
            ...owned,
            mimeType: 'text/plain',
            sizeBytes: 4,
            source: 'upload',
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt,
          },
        ],
        hasNextPage: true,
      },
    });
    show(['artifact.read']);
    const sortField = await screen.findByRole('combobox', { name: 'Sort by' });
    const lastQuery = () => mocks.files.mock.lastCall?.[0];
    expect(lastQuery()).toMatchObject({
      sortBy: 'createdAt',
      sortOrder: 'DESC',
      page: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(lastQuery()).toMatchObject({ page: 2 });
    fireEvent.keyDown(sortField, { key: 'ArrowDown' });
    const name = await screen.findByRole('option', { name: 'Name' });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(lastQuery()).toMatchObject({
      sortBy: 'name',
      sortOrder: 'DESC',
      page: 1,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sort ascending' }));
    expect(lastQuery()).toMatchObject({
      sortBy: 'name',
      sortOrder: 'ASC',
      page: 1,
    });
    fireEvent.keyDown(sortField, { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'Modified' }), {
      key: 'Enter',
    });
    expect(
      screen.getByRole('columnheader', { name: 'Modified' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
          new Date(updatedAt),
        ),
      ),
    ).toBeVisible();
  });

  it('changes the server page size and returns to the first page', async () => {
    mocks.files.mockReturnValue({
      isFetchedAfterMount: true,
      data: { data: [], total: 24, hasNextPage: true },
    });
    show(['artifact.read']);
    const pageSize = await screen.findByRole('combobox', {
      name: 'Files per page',
    });
    const lastQuery = () => mocks.files.mock.lastCall?.[0];
    expect(lastQuery()).toMatchObject({ limit: 20, page: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(lastQuery()).toMatchObject({ limit: 20, page: 2 });
    fireEvent.keyDown(pageSize, { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: '5' }), {
      key: 'Enter',
    });
    expect(lastQuery()).toMatchObject({ limit: 5, page: 1 });
  });

  it('hides file rows when a folder request denies the shared read permission', async () => {
    mocks.folders.mockReturnValue({
      isError: true,
      error: { isAxiosError: true, response: { status: 403 } },
    });
    show(['artifact.read']);
    expect(
      await screen.findByText('Could not verify access to Files.'),
    ).toBeVisible();
    expect(screen.queryByText('My report.txt')).toBeNull();
  });

  it('switches views without expanding a manager’s access to file content', async () => {
    show(['artifact.read', 'artifact.manage']);
    expect(
      await screen.findByRole('table', { name: 'Workspace files' }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'All files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    const grid = screen.getByRole('list', { name: 'Workspace file grid' });
    expect(localStorage.getItem('argus.files.view')).toBe('grid');
    expect(
      within(grid).getByRole('button', { name: 'Download My report.txt' }),
    ).toBeVisible();
    expect(
      within(grid).getByRole('button', { name: 'Delete Peer report.txt' }),
    ).toBeVisible();
    expect(
      within(grid).queryByRole('button', { name: 'Download Peer report.txt' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(
      screen.getByRole('table', { name: 'Workspace files' }),
    ).toBeVisible();
    expect(localStorage.getItem('argus.files.view')).toBe('list');
  });

  it('browses shared files in table and grid without management controls or folder filters', async () => {
    show(['artifact.read']);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Shared with me' }),
    );
    expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
      scope: 'shared',
      parentFolderId: undefined,
      page: 1,
    });
    expect(
      screen.getByRole('button', { name: 'Shared with me' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'All files' })).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Folder navigation' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Download Peer report.txt' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Delete Peer report.txt' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(
      within(
        screen.getByRole('list', { name: 'Workspace file grid' }),
      ).getByRole('button', { name: 'Download Peer report.txt' }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'My files' }));
    expect(mocks.files.mock.lastCall?.[0]).toMatchObject({
      scope: 'mine',
      parentFolderId: 'root',
      page: 1,
    });
    expect(screen.getByText('My report.txt')).toBeVisible();
  });

  it('downloads a named shared file through the existing cancellable request', async () => {
    mocks.download.mockResolvedValue({ url: '/api/storage/artifacts/shared' });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    try {
      show(['artifact.read']);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Shared with me' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Download Peer report.txt' }),
      );
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(mocks.download).toHaveBeenCalledWith(
        'peer',
        undefined,
        expect.any(AbortSignal),
      );
    } finally {
      click.mockRestore();
    }
  });

  it('offers a download for an owned file and no delete to a read-only viewer', async () => {
    mocks.download.mockResolvedValue({ url: '/api/storage/artifacts/test' });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    try {
      show(['artifact.read']);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Download My report.txt' }),
      );
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(mocks.download).toHaveBeenCalledWith(
        'mine',
        undefined,
        expect.any(AbortSignal),
      );
      expect(
        screen.queryByRole('button', { name: 'Delete My report.txt' }),
      ).toBeNull();
    } finally {
      click.mockRestore();
    }
  });

  it('discards a pending download when the workspace changes and switches back', async () => {
    let resolve!: (value: { url: string }) => void;
    const response = new Promise<{ url: string }>((finish) => {
      resolve = finish;
    });
    mocks.download.mockReturnValue(response);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    try {
      show(['artifact.read']);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Download My report.txt' }),
      );
      const signal = mocks.download.mock.calls[0][2] as AbortSignal;
      setGlobalWorkspaceId('another-workspace');
      setGlobalWorkspaceId('workspace');
      expect(signal.aborted).toBe(true);
      await act(async () => resolve({ url: '/api/storage/artifacts/test' }));
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
    }
  });

  it('requires confirmation to delete a peer file and withholds peer downloads', async () => {
    show(['artifact.read', 'artifact.manage']);
    fireEvent.click(await screen.findByRole('button', { name: 'All files' }));
    expect(
      screen.queryByRole('button', { name: 'Download Peer report.txt' }),
    ).toBeNull();
    const remove = screen.getByRole('button', {
      name: 'Delete Peer report.txt',
    });
    fireEvent.click(remove);
    let dialog = await screen.findByRole('dialog', { name: 'Delete file' });
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(remove);
    dialog = await screen.findByRole('dialog', { name: 'Delete file' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete file' }),
    );
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('peer'),
    );
  });
});
