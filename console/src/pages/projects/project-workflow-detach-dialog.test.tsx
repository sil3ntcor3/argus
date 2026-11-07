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
  projectsControllerGetById: mock.read,
  assetGroupControllerRemoveManyWorkflows: mock.remove,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: () => 'fixture',
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const bindingId = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';
const workflowId = 'b0147534-b242-4bbd-b548-15515a891bc6';
const key = ['/api/projects/' + projectId];
const binding = { id: bindingId, workflow: { id: workflowId } };
const other = { id: 'another-binding' };

function show(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkflowDetachDialog
        projectId={projectId}
        bindingId={bindingId}
        workflowId={workflowId}
        workflowName="Discovery"
        workspaceId="fixture"
        focusAssignments={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('button', {
    name: 'Detach workflow Discovery',
  });
  fireEvent.click(trigger);
  return {
    trigger,
    dialog: within(
      screen.getByRole('dialog', { name: 'Detach project workflow' }),
    ),
  };
}

describe('ProjectWorkflowDetachDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.read.mockResolvedValue({ assetGroupWorkflows: [binding, other] });
    mock.remove.mockResolvedValue({ message: 'Removed' });
  });

  it('detaches only the confirmed workflow and preserves other assignments in cache', async () => {
    const client = new QueryClient();
    client.setQueryData(key, { assetGroupWorkflows: [binding, other] });
    const { dialog, trigger } = show(client);
    expect(dialog.getByText(/past runs remain/i)).toBeVisible();
    expect(mock.remove).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: 'Detach workflow' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.remove).toHaveBeenCalledExactlyOnceWith(projectId, {
      workflowIds: [workflowId],
    });
    expect(client.getQueryData(key)).toEqual({ assetGroupWorkflows: [other] });
  });

  it('does not detach a replacement assignment made while the dialog was open', async () => {
    mock.read.mockResolvedValue({
      assetGroupWorkflows: [{ ...binding, id: 'replacement-binding' }],
    });
    const { dialog, trigger } = show();
    fireEvent.click(dialog.getByRole('button', { name: 'Detach workflow' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Workflow assignment changed',
    );
    expect(mock.remove).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
