import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetGroupWorkflow, Tool } from '@/services/apis/gen/queries';
import type { PipelineToolEntry } from '@/pages/asset-group/components/tool-pipeline-builder';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { ProjectWorkflowPipelineDialog } from './project-workflow-pipeline-dialog';

const mock = vi.hoisted(() => ({
  patch: vi.fn(),
  tools: vi.fn(),
  toast: vi.fn(),
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  projectsControllerUpdateWorkflow: mock.patch,
  useToolsControllerGetInstalledTools: mock.tools,
}));
vi.mock('sonner', () => ({ toast: { success: mock.toast } }));
vi.mock('@/pages/asset-group/components/tool-pipeline-builder', () => ({
  isPipelineValid: () => true,
  ToolPipelineBuilder: ({
    value,
    onChange,
    disabled,
    allowInstall,
  }: {
    value: PipelineToolEntry[];
    onChange: (v: PipelineToolEntry[]) => void;
    disabled: boolean;
    allowInstall: boolean;
  }) => (
    <>
      <pre aria-label="Draft">{JSON.stringify(value)}</pre>
      <button
        disabled={disabled}
        onClick={() =>
          onChange(value.map((e, i) => (i ? { ...e, stage: 3 } : e)))
        }
      >
        {allowInstall ? 'Edit with installer' : 'Edit'}
      </button>
    </>
  ),
}));
const key = ['/api/projects/project'];
const tools = [
  { id: 'probe', name: 'httpx' },
  { id: 'scan', name: 'nuclei' },
] as Tool[];
const binding: AssetGroupWorkflow = {
  id: 'binding',
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
  assetGroup: {},
  schedule: '0 5 * * *',
  workflow: {
    id: 'workflow',
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
    isCanEdit: true,
    isCanDelete: true,
    content: {
      name: 'Scan',
      jobs: {
        first: { run: 'httpx' },
        last: {
          run: 'nuclei',
          needs: ['first'],
          allowFailure: false,
          config: { token: 'stored' },
        },
      },
    },
  },
};

function editStage() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit with installer' }));
}

function show() {
  const client = new QueryClient();
  client.setQueryData(key, {
    assetGroupWorkflows: [binding, { id: 'sibling' }],
  });
  const ui = (value = binding) => (
    <QueryClientProvider client={client}>
      <ProjectWorkflowPipelineDialog
        projectId="project"
        binding={value}
        workflowName="Scan"
        workspaceId="fixture"
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  const trigger = screen.getByRole('button', {
    name: 'Edit pipeline for Scan',
  });
  fireEvent.click(trigger);
  return {
    client,
    view,
    ui,
    trigger,
    save: screen.getByRole('button', { name: 'Save pipeline' }),
  };
}

describe('ProjectWorkflowPipelineDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setGlobalWorkspaceId('fixture');
    mock.tools.mockReturnValue({ data: { data: tools }, refetch: vi.fn() });
    mock.patch.mockResolvedValue(binding);
  });

  it('preserves a staged draft across catalog refetches and saves stable IDs and metadata', async () => {
    const { view, ui, trigger, save, client } = show();
    expect(save).toBeDisabled();
    editStage();
    mock.tools.mockReturnValue({
      data: { data: [...tools, { id: 'new', name: 'naabu' }] },
    });
    view.rerender(ui());
    expect(screen.getByLabelText('Draft')).toHaveTextContent('"stage":3');
    fireEvent.click(save);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.patch).toHaveBeenCalledExactlyOnceWith('project', 'binding', {
      jobs: binding.workflow.content.jobs,
    });
    expect(client.getQueryData(key)).toEqual({
      assetGroupWorkflows: [binding, { id: 'sibling' }],
    });
    expect(mock.toast).toHaveBeenCalledOnce();
  });

  it('retains failed edits for retry and discards them on cancel', async () => {
    mock.patch.mockRejectedValueOnce(new Error('Unavailable'));
    const { trigger, save } = show();
    editStage();
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save',
    );
    expect(screen.getByLabelText('Draft')).toHaveTextContent('"stage":3');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(screen.getByLabelText('Draft')).not.toHaveTextContent('"stage":3');
  });

  it('blocks observed external changes and dispatch after a workspace switch', () => {
    const { view, ui, save } = show();
    editStage();
    view.rerender(
      ui({
        ...binding,
        workflow: { ...binding.workflow, updatedAt: 'changed' },
      }),
    );
    expect(save).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('changed');
    view.rerender(ui());
    setGlobalWorkspaceId('other');
    fireEvent.click(save);
    expect(mock.patch).not.toHaveBeenCalled();
  });

  it('blocks duplicate saves and ignores late responses after a workspace switch', async () => {
    let finish!: (v: AssetGroupWorkflow) => void;
    mock.patch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { save, client } = show();
    editStage();
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(mock.patch).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    setGlobalWorkspaceId('other');
    await act(async () => finish({ ...binding, schedule: 'disabled' }));
    expect(client.getQueryData(key)).toEqual({
      assetGroupWorkflows: [binding, { id: 'sibling' }],
    });
    expect(mock.toast).not.toHaveBeenCalled();
  });
});
