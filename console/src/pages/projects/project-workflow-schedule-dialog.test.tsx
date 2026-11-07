import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowScheduleDialog } from './project-workflow-schedule-dialog';

const mock = vi.hoisted(() => ({ fresh: vi.fn(), patch: vi.fn() }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  projectsControllerGetById: mock.fresh,
  assetGroupControllerUpdateAssetGroupWorkflow: mock.patch,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: () => 'fixture',
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const bindingId = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';
const saved = '0 2 1 1 *';

function show(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkflowScheduleDialog
        projectId={projectId}
        bindingId={bindingId}
        workflowName="Discovery"
        schedule={saved}
        workspaceId="fixture"
      />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('button', {
    name: /Edit schedule for Discovery/,
  });
  fireEvent.click(trigger);
  const dialog = within(
    screen.getByRole('dialog', { name: 'Edit workflow schedule' }),
  );
  return {
    trigger,
    dialog,
    input: dialog.getByRole('textbox', { name: 'Cron schedule (UTC)' }),
    save: dialog.getByRole('button', { name: 'Save schedule' }),
  };
}

describe('ProjectWorkflowScheduleDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.fresh.mockResolvedValue({
      assetGroupWorkflows: [{ id: bindingId, schedule: saved }],
    });
    mock.patch.mockResolvedValue({ id: bindingId, schedule: 'disabled' });
  });

  it('keeps the full saved expression and disables just the chosen binding', async () => {
    const client = new QueryClient();
    const key = ['/api/projects/' + projectId];
    const binding = {
      id: bindingId,
      schedule: saved,
      workflow: { name: 'Discovery' },
    };
    client.setQueryData(key, { assetGroupWorkflows: [binding] });
    const { trigger, input, save } = show(client);
    expect(input).toHaveValue(saved);
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: 'disabled' } });
    fireEvent.click(save);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.patch).toHaveBeenCalledExactlyOnceWith(bindingId, {
      schedule: 'disabled',
    });
    expect(client.getQueryData(key)).toEqual({
      assetGroupWorkflows: [{ ...binding, schedule: 'disabled' }],
    });
  });

  it('blocks a stale edit and loads the latest saved schedule without writing', async () => {
    const changed = '0 5 * 2 *';
    mock.fresh.mockResolvedValue({
      assetGroupWorkflows: [{ id: bindingId, schedule: changed }],
    });
    const { trigger, dialog, input, save } = show();
    fireEvent.change(input, { target: { value: 'disabled' } });
    fireEvent.click(save);
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      /Schedule changed/,
    );
    expect(input).toHaveValue('disabled');
    expect(mock.patch).not.toHaveBeenCalled();
    fireEvent.click(
      dialog.getByRole('button', { name: 'Load saved schedule' }),
    );
    expect(input).toHaveValue(changed);
    expect(input).toHaveFocus();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
