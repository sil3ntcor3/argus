import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import type { AssetGroupWorkflow as Binding } from '@/services/apis/gen/queries';
import AssetGroupWorkflow from './asset-group-workflow';

const state = vi.hoisted(() => ({ mutate: vi.fn(), change: undefined as undefined | ((value: unknown[]) => void) }));
vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<typeof import('@tanstack/react-router')>(), useNavigate: () => vi.fn(),
}));
vi.mock('./tool-pipeline-builder', () => ({
  ToolPipelineBuilder: ({ disabled, onChange }: { disabled: boolean; onChange: (value: unknown[]) => void }) => {
    state.change = onChange;
    return <button disabled={disabled}>Edit pipeline</button>;
  },
}));
vi.mock('@/services/apis/gen/queries', async (original) => {
  const actual = await original<typeof import('@/services/apis/gen/queries')>();
  const mutation = () => ({ mutate: state.mutate, mutateAsync: state.mutate, isPending: false });
  return {
    ...actual,
    useToolsControllerGetInstalledTools: () => ({ data: { data: [{ id: 'tool-1', name: 'amass', type: 'provider' }] }, isLoading: false }),
    useAssetGroupControllerUpdateAssetGroupWorkflow: mutation,
    useAssetGroupControllerAddManyWorkflows: mutation,
    useAssetGroupControllerRemoveManyWorkflows: mutation,
    useWorkflowsControllerCreateWorkflow: mutation,
    useWorkflowsControllerUpdateWorkflow: mutation,
    useWorkflowsControllerDeleteWorkflow: mutation,
  };
});

describe('AssetGroupWorkflow editing safety', () => {
  it('protects multiple jobs of one tool, including a stale child submission', async () => {
    state.mutate.mockClear();
    const binding = {
      id: 'binding', schedule: 'disabled',
      workflow: { id: 'workflow', content: { name: 'Multiple categories', jobs: {
        enum: { run: 'amass', category: 'subdomains' },
        scan: { run: 'amass', category: 'vulnerabilities', needs: ['enum'] },
      } } },
    } as unknown as Binding;
    renderWithProviders(<AssetGroupWorkflow assetGroupId="group" workflows={[binding]} onRefetch={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Edit pipeline' })).toBeDisabled();
    expect(screen.getByText(/Individual job editing is not available here/)).toBeVisible();
    state.change?.([]);
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });
});
