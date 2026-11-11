import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDeleteDialog } from './project-delete-dialog';

const mock = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  projectsControllerDelete: mock.request,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mock.navigate,
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: mock.workspace,
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';

function show(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <ProjectDeleteDialog
        projectId={projectId}
        projectName="Perimeter"
        workspaceId="fixture"
      />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'Delete project' });
  fireEvent.click(trigger);
  return {
    trigger,
    dialog: within(screen.getByRole('dialog', { name: 'Delete project' })),
  };
}

describe('ProjectDeleteDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workspace.mockReturnValue('fixture');
    mock.request.mockResolvedValue({ message: 'Deleted' });
  });

  it('requires typing delete and restores focus after cancel', async () => {
    const { dialog, trigger } = show();
    const confirm = dialog.getByRole('button', { name: 'Delete project' });
    const input = dialog.getByRole('textbox', {
      name: 'Type delete to confirm',
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Delete' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'delete' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.request).not.toHaveBeenCalled();
  });

  it('keeps confirmation open after a failed request and navigates on retry', async () => {
    mock.request.mockRejectedValueOnce(new Error('Request failed'));
    const { dialog, trigger } = show();
    const confirm = dialog.getByRole('button', { name: 'Delete project' });
    const input = dialog.getByRole('textbox', {
      name: 'Type delete to confirm',
    });
    fireEvent.change(input, { target: { value: 'delete' } });
    fireEvent.click(confirm);
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Unable to delete the project',
    );
    expect(input).toHaveValue('delete');
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mock.navigate).toHaveBeenCalledExactlyOnceWith({
        to: '/projects',
        replace: true,
      }),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.request.mock.calls).toEqual([[projectId], [projectId]]);
  });

  it('evicts a deleted project without redirecting after a workspace switch', async () => {
    const client = new QueryClient();
    const projectKey = ['/api/projects/' + projectId.toUpperCase()];
    const listKey = ['/api/projects'];
    const legacyListKey = ['asset-group', 10, 1, 'name', 'asc', ''];
    client.setQueryData(projectKey, { id: projectId });
    for (const key of [listKey, legacyListKey])
      client.setQueryData(key, { data: [{ id: projectId }] });
    let resolve!: (result: { message: string }) => void;
    mock.request.mockReturnValue(
      new Promise<{ message: string }>((finish) => {
        resolve = finish;
      }),
    );

    const { dialog, trigger } = show(client);
    fireEvent.change(dialog.getByRole('textbox'), {
      target: { value: 'delete' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledOnce());
    mock.workspace.mockReturnValue('another-workspace');
    resolve({ message: 'Deleted' });
    await waitFor(() =>
      expect(client.getQueryData(projectKey)).toBeUndefined(),
    );
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(legacyListKey)?.isInvalidated).toBe(true);
    expect(mock.navigate).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
