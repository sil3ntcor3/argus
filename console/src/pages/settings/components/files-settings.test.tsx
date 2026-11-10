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

function show(permissions: string[]) {
  mocks.permission.mockReturnValue({
    hasPermission: (key: string) => permissions.includes(key),
    refetch: vi.fn(),
  });
  return renderWithProviders(<FilesSettings />);
}

describe('Files settings actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download.mockReset();
    mocks.remove.mockReset();
    mocks.folders.mockReturnValue({ isFetchedAfterMount: true, data: [] });
    mocks.folderDetail.mockReturnValue({});
    localStorage.removeItem('argus.files.view');
    mocks.files.mockImplementation((params: { scope: string }) => ({
      isFetchedAfterMount: true,
      data: {
        data: (params.scope === 'all' ? [owned, peer] : [owned]).map(
          (file) => ({
            ...file,
            mimeType: 'text/plain',
            sizeBytes: 4,
            source: 'upload',
            createdAt: '2026-01-02T00:00:00Z',
          }),
        ),
      },
    }));
    setGlobalWorkspaceId('workspace');
  });

  it('browses personal folders with breadcrumbs and searches across folders', async () => {
    const reports = { id: 'reports', name: 'Reports' };
    const archive = { id: 'archive', name: 'Archive' };
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
    expect(lastFileFilter()).toMatchObject({
      parentFolderId: reports.id,
      page: 1,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(lastFileFilter()).toMatchObject({
      parentFolderId: archive.id,
      page: 1,
    });
    const path = screen.getByRole('navigation', { name: 'Folder path' });
    expect(within(path).getByText('Archive')).toHaveAttribute(
      'aria-current',
      'location',
    );
    fireEvent.click(within(path).getByRole('button', { name: 'Reports' }));
    expect(lastFileFilter()).toMatchObject({ parentFolderId: reports.id });

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
