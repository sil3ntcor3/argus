import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { server } from '@/test/mocks/node';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  getArtifactsControllerGetByIdQueryKey,
  type ArtifactListItemDto,
} from '@/services/apis/gen/queries';
import { FileSharingDialog } from './file-sharing-dialog';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  copy: vi.fn(),
  denied: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.success, warning: mocks.warning },
}));
vi.mock('@/lib/handle-server-error', () => ({
  handleServerError: mocks.error,
}));

const original: ArtifactListItemDto = {
  id: 'file',
  name: 'Report.txt',
  shareType: 'private',
  isOwner: true,
  createdBy: { id: 'owner', name: 'Owner', image: null },
  mimeType: 'text/plain',
  sizeBytes: 1,
  source: 'upload',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const member = { id: 'member', name: 'Recipient', image: null };
let storedFile: ArtifactListItemDto;
let recipients: (typeof member)[];
let writes: Array<{ method: string; body: unknown; workspace: string | null }>;

/** Render the actual generated query hooks against intercepted HTTP requests. */
function show(client?: QueryClient) {
  return renderWithProviders(
    <FileSharingDialog
      file={original}
      workspaceId="workspace"
      focusAfterClose={{ current: null }}
      onClose={vi.fn()}
      onAccessDenied={mocks.denied}
    />,
    { queryClient: client },
  );
}

/** Select a mode through the accessible Radix combobox. */
async function chooseAccess(label: string) {
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'General access' }),
    ).toBeEnabled(),
  );
  fireEvent.keyDown(
    await screen.findByRole('combobox', { name: 'General access' }),
    { key: 'ArrowDown' },
  );
  fireEvent.keyDown(await screen.findByRole('option', { name: label }), {
    key: 'Enter',
  });
}

describe('Owner file sharing dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedFile = { ...original };
    recipients = [];
    writes = [];
    setGlobalWorkspaceId('workspace');
    mocks.copy.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.copy },
    });
    server.use(
      http.get('*/api/artifacts/file', () => HttpResponse.json(storedFile)),
      http.get('*/api/artifacts/file/shares', () =>
        HttpResponse.json(recipients),
      ),
      http.patch('*/api/artifacts/file', async ({ request }) => {
        const body = (await request.json()) as {
          shareType: ArtifactListItemDto['shareType'];
        };
        writes.push({
          method: 'PATCH',
          body,
          workspace: request.headers.get('X-Workspace-Id'),
        });
        storedFile = { ...storedFile, shareType: body.shareType };
        return HttpResponse.json(storedFile);
      }),
      http.post('*/api/artifacts/file/shares', async ({ request }) => {
        writes.push({
          method: 'POST',
          body: await request.json(),
          workspace: request.headers.get('X-Workspace-Id'),
        });
        recipients = [member];
        return HttpResponse.json({ shared: 1, skipped: 1 }, { status: 201 });
      }),
      http.delete('*/api/artifacts/file/shares/member', () => {
        recipients = [];
        return HttpResponse.json({ message: 'Share removed' });
      }),
    );
  });

  it('waits for fresh ownership instead of enabling controls from cached metadata', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.get('*/api/artifacts/file', async () => {
        await pending;
        return HttpResponse.json({ ...storedFile, isOwner: false });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      getArtifactsControllerGetByIdQueryKey(original.id),
      original,
    );
    show(client);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Loading file access',
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    await act(async () => finish());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'no longer owned',
    );
    expect(screen.queryByRole('textbox', { name: 'Add people' })).toBeNull();
  });

  it('retries metadata and recipient read errors without showing cached recipients', async () => {
    let failMetadata = true;
    let failRecipients = true;
    server.use(
      http.get('*/api/artifacts/file', () =>
        failMetadata
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json(storedFile),
      ),
      http.get('*/api/artifacts/file/shares', () =>
        failRecipients
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json([member]),
      ),
    );
    show();
    expect(
      await screen.findByText('Could not verify file ownership.'),
    ).toBeVisible();
    failMetadata = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry file access' }));
    expect(await screen.findByText('Could not load recipients.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    failRecipients = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry recipients' }));
    expect(await screen.findByText('Recipient', { exact: true })).toBeVisible();
  });

  it('validates recipient input before sending requests', async () => {
    show();
    const input = await screen.findByRole('textbox', { name: 'Add people' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled(),
    );
    for (const value of [
      '',
      Array.from({ length: 51 }, (_, index) => `user${index}@example.com`).join(
        ',',
      ),
    ]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'between 1 and 50 email',
      );
    }
    expect(writes).toEqual([]);
    server.use(
      http.post('*/api/artifacts/file/shares', () =>
        HttpResponse.json(
          { message: 'Invalid email address' },
          { status: 400 },
        ),
      ),
    );
    fireEvent.change(input, { target: { value: 'invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check each email address',
    );
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it('normalizes international recipients, enables a private file, and refreshes the returned mode and list', async () => {
    show();
    const input = await screen.findByRole('textbox', { name: 'Add people' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, {
      target: {
        value: ' ÁLÎCE@EXAMPLE.COM, álîce@example.com; missing@example.com ',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Recipient', { exact: true })).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'General access' }),
      ).toHaveTextContent('Selected members'),
    );
    expect(writes).toEqual([
      {
        method: 'POST',
        body: { emails: ['álîce@example.com', 'missing@example.com'] },
        workspace: 'workspace',
      },
      {
        method: 'PATCH',
        body: { shareType: 'shared' },
        workspace: 'workspace',
      },
    ]);
    expect(input).toHaveValue('');
    expect(mocks.warning).toHaveBeenCalledWith('One email address was skipped');
  });

  it('retries safely after recipients save but enabling shared access fails', async () => {
    let fail = true;
    server.use(
      http.patch('*/api/artifacts/file', () => {
        if (fail) return new HttpResponse(null, { status: 500 });
        storedFile = { ...storedFile, shareType: 'shared' };
        return HttpResponse.json(storedFile);
      }),
    );
    show();
    const input = await screen.findByRole('textbox', { name: 'Add people' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'member@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText(
        'Recipients were saved. Set General access to Selected members to allow downloads.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('combobox', { name: 'General access' }),
    ).toHaveTextContent('Private');
    expect(input).toHaveValue('member@example.com');
    fail = false;
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'General access' }),
      ).toHaveTextContent('Selected members'),
    );
    expect(
      within(screen.getByRole('region', { name: 'Recipients' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(1);
  });

  it('removes a recipient and keeps focus in the recipient section', async () => {
    recipients = [member];
    show();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove Recipient' }),
    );
    expect(await screen.findByText('No recipients added.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Recipients' })).toHaveFocus();
  });

  it('updates public and private modes and handles clipboard failure', async () => {
    show();
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(mocks.copy);
    await chooseAccess('Public link');
    const link = await screen.findByRole('textbox', { name: 'Public link' });
    expect(link).toHaveValue(
      `${window.location.origin}/api/public/artifacts/file`,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Copy public link' }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy public link' }));
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith(link.getAttribute('value')),
    );
    mocks.copy.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy public link' }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Clipboard unavailable' }),
      ),
    );
    await chooseAccess('Private');
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Public link' })).toBeNull(),
    );
  });

  it('discards a pending mode response after the dialog unmounts', async () => {
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    server.use(
      http.patch('*/api/artifacts/file', async () => {
        started();
        await pending;
        return HttpResponse.json({ ...storedFile, shareType: 'public' });
      }),
    );
    const view = show();
    await chooseAccess('Public link');
    await entered;
    view.unmount();
    await act(async () => finish());
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('aborts an in-flight change when the workspace switches away and back', async () => {
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    server.use(
      http.post('*/api/artifacts/file/shares', async () => {
        started();
        await pending;
        return HttpResponse.json({ shared: 1, skipped: 0 }, { status: 201 });
      }),
    );
    show();
    const input = await screen.findByRole('textbox', { name: 'Add people' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'member@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await entered;
    await act(async () => {
      setGlobalWorkspaceId('other');
      setGlobalWorkspaceId('workspace');
      finish();
    });
    await waitFor(() =>
      expect(screen.queryByText('Saving sharing changes…')).toBeNull(),
    );
    expect(writes).toEqual([]);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
