import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTriggerDto } from '@/services/apis/gen/queries';
import { ProjectTriggerManageDialog } from './project-trigger-manage-dialog';
const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  workspace: 'workspace-a',
  toast: vi.fn(),
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: () => mocks.workspace,
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toast } }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  projectsControllerUpdateTrigger: mocks.update,
  projectsControllerRemoveTrigger: mocks.remove,
}));
const row = {
  id: 'trigger',
  projectWorkflowId: 'binding',
  type: 'cron',
  cron: '0 8 * * *',
  enabled: false,
  config: {},
  event: null,
} as ProjectTriggerDto;
function mount(
  trigger = row,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const view = render(
    <QueryClientProvider client={client}>
      <ProjectTriggerManageDialog
        trigger={trigger}
        projectId="project"
        workspaceId="workspace-a"
        workflowName="Discovery"
        otherWorkflows={[]}
      />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.resetAllMocks();
  mocks.workspace = 'workspace-a';
  mocks.update.mockResolvedValue({ ...row, enabled: true });
  mocks.remove.mockResolvedValue({ message: 'Trigger removed' });
});
describe('Project trigger management', () => {
  it('requires explicit confirmation before enabling automatic scans', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Enable.*Discovery/ }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'start scans automatically',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enable trigger' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('project', 'trigger', {
        enabled: true,
      }),
    );
  });
  it('validates and normalizes cron edits without changing activation', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Edit.*Discovery/ }));
    const field = screen.getByRole('textbox', {
      name: 'Cron expression (UTC)',
    });
    fireEvent.change(field, { target: { value: 'bad' } });
    expect(screen.getByRole('button', { name: 'Save trigger' })).toBeDisabled();
    fireEvent.change(field, { target: { value: ' 0  9 * * * ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save trigger' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('project', 'trigger', {
        cron: '0 9 * * *',
        enabled: false,
      }),
    );
  });
  it('confirms removal and uses only the original selected workspace', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Remove.*Discovery/ }));
    mocks.workspace = 'workspace-b';
    fireEvent.click(screen.getByRole('button', { name: 'Remove trigger' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('does not replay an uncertain write after field changes', async () => {
    mocks.update.mockRejectedValue(new Error('lost response'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Edit.*Discovery/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save trigger' }));
    await screen.findByRole('alert');
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Cron expression (UTC)' }),
      { target: { value: '0 10 * * *' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save trigger' }));
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it('removes a trigger only after confirmation', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Remove.*Discovery/ }));
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove trigger' }));
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith('project', 'trigger'),
    );
  });
  it('validates event filters and preserves the immutable event kind', async () => {
    mount({
      ...row,
      type: 'event',
      cron: null,
      event: 'vulnerability.detected',
      config: {
        severity: ['high'],
        targetTypes: ['DOMAIN'],
        windowMinutes: 3,
        maxAssets: 8,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /Edit.*Discovery/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'High' }));
    expect(screen.getByRole('button', { name: 'Save trigger' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Medium' }));
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Gather for (minutes)' }),
      { target: { value: '0' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save trigger' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('project', 'trigger', {
        enabled: false,
        config: {
          severity: ['medium'],
          targetTypes: ['DOMAIN'],
          windowMinutes: 0,
          maxAssets: 8,
        },
      }),
    );
  });
  it('holds the shared mutation lock across remounts and ignores late workspace success', async () => {
    let release!: (value: ProjectTriggerDto) => void;
    mocks.update.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { unmount, client } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Enable.*Discovery/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable trigger' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    unmount();
    mount(row, client);
    fireEvent.click(screen.getByRole('button', { name: /Edit.*Discovery/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mocks.workspace = 'workspace-b';
    release({ ...row, enabled: true });
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it.each(['edit', 'toggle'] as const)(
    'blocks a stale %s dialog without reversing the confirmed action',
    async (mode) => {
      const initial = { ...row, enabled: true };
      const { rerender, client } = mount(initial);
      fireEvent.click(
        screen.getByRole('button', {
          name: mode === 'edit' ? /Edit.*Discovery/ : /Disable.*Discovery/,
        }),
      );
      const changed = { ...initial, enabled: false, cron: '0 11 * * *' };
      rerender(
        <QueryClientProvider client={client}>
          <ProjectTriggerManageDialog
            trigger={changed}
            projectId="project"
            workspaceId="workspace-a"
            workflowName="Discovery"
            otherWorkflows={[]}
          />
        </QueryClientProvider>,
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'changed while',
      );
      const save = screen.getByRole('button', {
        name: mode === 'edit' ? 'Save trigger' : 'Disable trigger',
      });
      expect(save).toBeDisabled();
      fireEvent.click(save);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it('keeps edits available when only the last-fired metadata changes', () => {
    const { rerender, client } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Edit.*Discovery/ }));
    rerender(
      <QueryClientProvider client={client}>
        <ProjectTriggerManageDialog
          trigger={{
            ...row,
            updatedAt: new Date().toISOString(),
            lastFiredAt: new Date().toISOString(),
          }}
          projectId="project"
          workspaceId="workspace-a"
          workflowName="Discovery"
          otherWorkflows={[]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Save trigger' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('returns keyboard focus to the invoking control after cancellation', async () => {
    mount();
    const button = screen.getByRole('button', { name: /Edit.*Discovery/ });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Cron expression (UTC)' }),
      ).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(button).toHaveFocus());
  });
});
