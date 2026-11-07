import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowRunDialog } from './project-workflow-run-dialog';

const mock = vi.hoisted(() => ({ run: vi.fn(), workspace: vi.fn() }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  assetGroupControllerRunGroupWorkflowScheduler: mock.run,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: string }) => (
    <a href="/projects/runs">{children}</a>
  ),
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: mock.workspace,
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const bindingId = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';

function show(hasAssets = true, hasSteps = true) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectWorkflowRunDialog
        projectId={projectId}
        bindingId={bindingId}
        workflowName="Discovery"
        workspaceId="fixture"
        hasAssets={hasAssets}
        hasSteps={hasSteps}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole('button', { name: 'Run workflow for Discovery' });
}

describe('ProjectWorkflowRunDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workspace.mockReturnValue('fixture');
    mock.run.mockResolvedValue({ message: 'Started' });
  });

  it('requires project assets before a user can confirm a run', () => {
    expect(show(false)).toBeDisabled();
    expect(mock.run).not.toHaveBeenCalled();
  });

  it('disables launch for a workflow with no steps', () => {
    expect(show(true, false)).toBeDisabled();
    expect(screen.getByText('The workflow has no steps')).toBeVisible();
    expect(mock.run).not.toHaveBeenCalled();
  });

  it('requires fresh confirmation after an ambiguous response', async () => {
    mock.run.mockRejectedValueOnce(new Error('Request failed'));
    const trigger = show();
    fireEvent.click(trigger);
    const dialog = within(
      screen.getByRole('dialog', { name: 'Run project workflow' }),
    );
    const run = dialog.getByRole('button', { name: 'Start run' });
    expect(dialog.getByText(/current project assets/)).toBeVisible();
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(run);
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Could not confirm the workflow started',
    );
    expect(dialog.queryByRole('button', { name: 'Start run' })).toBeNull();
    expect(
      dialog.getByRole('link', { name: 'View project runs' }),
    ).toBeVisible();
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    const reopened = within(
      screen.getByRole('dialog', { name: 'Run project workflow' }),
    );
    fireEvent.click(reopened.getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.run.mock.calls).toEqual([[bindingId], [bindingId]]);
  });
});
