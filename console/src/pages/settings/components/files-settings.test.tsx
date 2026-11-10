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
  useArtifactsControllerGetMany: (params: { scope: string }) => ({
    isFetchedAfterMount: true,
    data: {
      data: (params.scope === 'all' ? [owned, peer] : [owned]).map((file) => ({
        ...file,
        mimeType: 'text/plain',
        sizeBytes: 4,
        source: 'upload',
        createdAt: '2026-01-02T00:00:00Z',
      })),
    },
  }),
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
    setGlobalWorkspaceId('workspace');
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
