import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import type { Tool } from '@/services/apis/gen/queries';
import { ToolPipelineBuilder } from '@/pages/asset-group/components/tool-pipeline-builder';

const fixture = vi.hoisted(() => ({
  workspace: 'workspace',
  canWrite: true,
  queryError: false,
  query: vi.fn(),
  install: vi.fn(),
  options: vi.fn(),
  invalidate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({
    state: { selectedWorkspaceId: fixture.workspace },
  }),
}));
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ hasPermission: () => fixture.canWrite }),
}));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: () => fixture.workspace,
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: fixture.invalidate }),
}));
vi.mock('sonner', () => ({
  toast: { success: fixture.success, error: fixture.error },
}));
vi.mock('@/components/tools/tool-install-confirm-dialog', () => ({
  ToolInstallConfirmDialog: ({
    tool,
    trigger,
    onConfirm,
  }: {
    tool: Tool;
    trigger: React.ReactNode;
    onConfirm: () => void;
  }) => (
    <div>
      {trigger}
      <button onClick={onConfirm}>Confirm {tool.name}</button>
    </div>
  ),
}));
vi.mock('@/services/apis/gen/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/apis/gen/queries')>()),
  useToolsControllerGetManyTools: (...args: unknown[]) =>
    fixture.query(...args),
  useToolsControllerInstallTool: (options: unknown) => {
    fixture.options(options);
    return { mutateAsync: fixture.install };
  },
  useToolConfigProfilesControllerList: () => ({ data: [], isLoading: false }),
}));
const existing = {
  id: 'existing',
  name: 'Existing',
  type: 'provider',
  logoUrl: '',
} as unknown as Tool;
const candidate = {
  id: 'candidate',
  name: 'Candidate',
  type: 'provider',
  logoUrl: '',
  isInstalled: false,
} as unknown as Tool;
const pipeline = [
  {
    toolId: existing.id,
    stage: 3,
    input: ['host'] as ['host'],
    config: { keep: true },
  },
];
const renderPicker = (disabled = false) => {
  const onChange = vi.fn();
  return {
    ...renderWithProviders(
      <ToolPipelineBuilder
        tools={[existing]}
        value={pipeline}
        onChange={onChange}
        allowInstall
        disabled={disabled}
      />,
    ),
    onChange,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.workspace = 'workspace';
  fixture.canWrite = true;
  fixture.queryError = false;
  fixture.install.mockResolvedValue({});
  fixture.invalidate.mockResolvedValue(undefined);
  fixture.query.mockImplementation(() => ({
    data: {
      data: [
        candidate,
        { ...existing, isInstalled: false },
        { ...candidate, id: 'installed', name: 'Installed', isInstalled: true },
      ],
    },
    isLoading: false,
    isFetching: false,
    isError: fixture.queryError,
    refetch: vi.fn(),
  }));
});

describe('Workflow inline tool installation', () => {
  it('offers only uninstalled catalog tools without altering the draft', async () => {
    const { onChange } = renderPicker();
    expect(
      await screen.findByRole('button', { name: 'Install Candidate' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Install Existing' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Install Installed' }),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('searches the server beyond the initial catalog page', async () => {
    const { user } = renderPicker();
    await user.type(
      await screen.findByRole('textbox', { name: 'Search tools to install' }),
      'far-tool',
    );
    await waitFor(() =>
      expect(fixture.query).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'far-tool', limit: 100 }),
        expect.anything(),
      ),
    );
  });

  it('installs on confirmation and refreshes tools while preserving staged selections', async () => {
    const { user, onChange } = renderPicker();
    await user.type(
      await screen.findByPlaceholderText('Search installed tools...'),
      'Existing',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm Candidate' }));
    await waitFor(() => expect(fixture.success).toHaveBeenCalled());
    expect(
      screen.getByPlaceholderText('Search installed tools...'),
    ).toHaveValue('');
    expect(fixture.install).toHaveBeenCalledWith({
      data: { toolId: candidate.id },
    });
    expect(fixture.invalidate).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Stage 3', { exact: true })).toBeVisible();
  });

  it('reports installation failure without changing the draft', async () => {
    fixture.install.mockRejectedValueOnce(new Error('Fixture outage'));
    const { user, onChange } = renderPicker();
    await user.click(
      await screen.findByRole('button', { name: 'Confirm Candidate' }),
    );
    await waitFor(() => expect(fixture.error).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
    expect(fixture.success).not.toHaveBeenCalled();
  });

  it('hides installation for a reader and disables it during processing', async () => {
    fixture.canWrite = false;
    const { unmount } = renderPicker();
    expect(
      screen.queryByRole('button', { name: 'Install Candidate' }),
    ).toBeNull();
    unmount();
    fixture.canWrite = true;
    renderPicker(true);
    expect(
      await screen.findByRole('button', { name: 'Install Candidate' }),
    ).toBeDisabled();
  });

  it('ignores a completed installation after the workspace changes', async () => {
    let finish!: () => void;
    fixture.install.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const { user, onChange } = renderPicker();
    await user.click(
      await screen.findByRole('button', { name: 'Confirm Candidate' }),
    );
    expect(fixture.options.mock.lastCall?.[0]).toMatchObject({
      mutation: { networkMode: 'always', retry: false },
    });
    fixture.workspace = 'other';
    finish();
    await waitFor(() => expect(fixture.invalidate).toHaveBeenCalled());
    expect(fixture.success).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a retryable catalog error', async () => {
    fixture.queryError = true;
    renderPicker();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load tools',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
