import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAssetAddDialog } from './project-asset-add-dialog';

const mock = vi.hoisted(() => ({ candidates: vi.fn(), add: vi.fn() }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetAssetCandidates: mock.candidates,
  useProjectsControllerAddAssets: mock.add,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: () => 'workspace',
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const first = {
  id: '29c7b635-4793-4e90-bf56-9a2a2b2562d3',
  value: 'first.argus.test',
};
const second = {
  id: 'e13a3774-14bc-42bb-8d64-46c3680a57aa',
  value: 'second.argus.test',
};

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectAssetAddDialog projectId={projectId} />
    </QueryClientProvider>,
  );
  expect(mock.candidates).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: 'Add assets' });
  fireEvent.click(trigger);
  return {
    trigger,
    dialog: within(screen.getByRole('dialog', { name: 'Add project assets' })),
  };
}

describe('ProjectAssetAddDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.add.mockReturnValue({ reset: vi.fn(), mutateAsync: vi.fn() });
    mock.candidates.mockImplementation((_id, query) => ({
      data: {
        data: query.page === 1 ? [first] : [second],
        hasNextPage: query.page === 1,
        pageCount: 2,
      },
    }));
  });

  it('keeps manual selections across candidate pages and submits both IDs', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ count: 2 });
    mock.add.mockReturnValue({ reset: vi.fn(), mutateAsync });
    const { dialog, trigger } = show();
    const add = dialog.getByRole('button', { name: 'Add selected assets' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(dialog.getByRole('checkbox', { name: /first.argus.test/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Next choices' }));
    fireEvent.click(
      dialog.getByRole('checkbox', { name: /second.argus.test/ }),
    );
    expect(dialog.getByText('2 selected')).toBeVisible();
    fireEvent.click(add);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({
      id: projectId,
      data: { assetIds: [first.id, second.id] },
    });
  });

  it('uses a literal asset query and returns to the first candidate page', async () => {
    const { dialog, trigger } = show();
    fireEvent.click(dialog.getByRole('button', { name: 'Next choices' }));
    fireEvent.change(
      dialog.getByRole('searchbox', { name: 'Search candidate assets' }),
      {
        target: { value: '%_' },
      },
    );
    fireEvent.submit(
      dialog.getByRole('search', { name: 'Candidate asset search' }),
    );
    expect(mock.candidates).toHaveBeenLastCalledWith(
      projectId,
      {
        page: 1,
        limit: 20,
        sortBy: 'value',
        sortOrder: 'ASC',
        search: '\\%\\_',
      },
      expect.anything(),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
