import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowDetachDialog } from './project-workflow-detach-dialog';

const mock = vi.hoisted(() => ({ read: vi.fn(), remove: vi.fn() }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  projectsControllerRemoveWorkflow: mock.remove,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: () => 'fixture',
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const bindingId = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';

function show(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkflowDetachDialog
        projectId={projectId}
        bindingId={bindingId}
        workflowName="Discovery"
        workspaceId="fixture"
        focusAssignments={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('button', {
    name: 'Remove workflow Discovery',
  });
  fireEvent.click(trigger);
  return {
    trigger,
    dialog: within(
      screen.getByRole('dialog', { name: 'Remove project workflow' }),
    ),
  };
}

describe('ProjectWorkflowDetachDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.remove.mockResolvedValue({ message: 'Removed' });
  });

  it('removes only the binding confirmed by ID and describes owned run deletion', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { dialog, trigger } = show(client);
    expect(dialog.getByText(/runs and jobs will be deleted/)).toBeVisible();
    expect(mock.remove).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: 'Remove workflow' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.remove).toHaveBeenCalledExactlyOnceWith(
      projectId,
      bindingId,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: { 'X-Workspace-Id': 'fixture' },
      }),
    );
    expect(invalidate).toHaveBeenCalled();
  });

  it('retains an uncertain removal across dialog reopenings without replay', async () => {
    mock.remove.mockRejectedValueOnce(new Error('Lost response'));
    const { dialog, trigger } = show();
    fireEvent.click(dialog.getByRole('button', { name: 'Remove workflow' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Could not confirm removal',
    );
    expect(
      dialog.getByRole('button', { name: 'Remove workflow' }),
    ).toBeDisabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(
      screen.getByRole('button', { name: 'Remove workflow' }),
    ).toBeDisabled();
    expect(mock.remove).toHaveBeenCalledTimes(1);
  });
});
