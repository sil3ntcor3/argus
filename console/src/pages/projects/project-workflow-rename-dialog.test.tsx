import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { ProjectWorkflowRenameDialog } from './project-workflow-rename-dialog';

const mock = vi.hoisted(() => ({ patch: vi.fn(), success: vi.fn() }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  projectsControllerUpdateWorkflow: mock.patch,
}));
vi.mock('sonner', () => ({ toast: { success: mock.success } }));

const key = ['/api/projects/project'];
const binding = {
  id: 'binding',
  schedule: 'disabled',
  lastRun: { id: 'run' },
  workflow: { content: { name: 'Before', jobs: {} } },
};
const renamed = {
  ...binding,
  workflow: { content: { name: 'After', jobs: {} } },
};

function show() {
  const client = new QueryClient();
  client.setQueryData(key, {
    assetGroupWorkflows: [binding, { id: 'sibling' }],
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ProjectWorkflowRenameDialog
        projectId="project"
        bindingId="binding"
        workflowName="Before"
        workspaceId="fixture"
      />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('button', {
    name: 'Rename workflow Before',
  });
  fireEvent.click(trigger);
  return {
    client,
    view,
    trigger,
    input: screen.getByRole('textbox', { name: 'Workflow name' }),
    save: screen.getByRole('button', { name: 'Save name' }),
  };
}

describe('ProjectWorkflowRenameDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setGlobalWorkspaceId('fixture');
    mock.patch.mockResolvedValue(renamed);
  });

  it('saves the trimmed name, updates its cached binding and restores focus', async () => {
    const { client, trigger, input, save } = show();
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: '  After  ' } });
    fireEvent.click(save);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.patch).toHaveBeenCalledExactlyOnceWith('project', 'binding', {
      name: 'After',
    });
    expect(client.getQueryData(key)).toEqual({
      assetGroupWorkflows: [renamed, { id: 'sibling' }],
    });
    expect(mock.success).toHaveBeenCalledOnce();
  });

  it('validates Unicode names and preserves a failed edit for retry or cancel', async () => {
    mock.patch.mockRejectedValueOnce(new Error('Unavailable'));
    const { trigger, input, save } = show();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: '🔎'.repeat(121) } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: '🔎'.repeat(120) } });
    expect(save).toBeEnabled();
    fireEvent.change(input, { target: { value: 'After' } });
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not rename',
    );
    expect(input).toHaveValue('After');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveValue(
      'Before',
    );
  });

  it('blocks an untouched draft when a refetch changes the saved name', () => {
    const { client, view, input, save } = show();
    view.rerender(
      <QueryClientProvider client={client}>
        <ProjectWorkflowRenameDialog
          projectId="project"
          bindingId="binding"
          workflowName="Someone else renamed this"
          workspaceId="fixture"
        />
      </QueryClientProvider>,
    );
    expect(input).toHaveValue('Before');
    expect(save).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Someone else renamed this',
    );
  });

  it('blocks submission after a workspace change', () => {
    const { input, save } = show();
    fireEvent.change(input, { target: { value: 'After' } });
    setGlobalWorkspaceId('other');
    fireEvent.click(save);
    expect(mock.patch).not.toHaveBeenCalled();
  });

  it('blocks duplicate saves and ignores a late response from another workspace', async () => {
    let finish!: (value: typeof renamed) => void;
    mock.patch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { client, input, save } = show();
    fireEvent.change(input, { target: { value: 'After' } });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(mock.patch).toHaveBeenCalledOnce());
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    setGlobalWorkspaceId('other');
    await act(async () => finish(renamed));
    expect(client.getQueryData(key)).toEqual({
      assetGroupWorkflows: [binding, { id: 'sibling' }],
    });
    expect(mock.success).not.toHaveBeenCalled();
  });
});
