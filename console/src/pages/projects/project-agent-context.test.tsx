import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectViewDto } from '@/services/apis/gen/queries';
import { ProjectAgentContext } from './project-agent-context';

const mock = vi.hoisted(() => ({ files: vi.fn(), fresh: vi.fn(), update: vi.fn(), presign: vi.fn(), complete: vi.fn(), remove: vi.fn(), workspace: 'workspace' }));
vi.mock('@/utils/workspaceState', () => ({ getGlobalWorkspaceId: () => mock.workspace }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/services/apis/gen/queries', async original => ({ ...(await original()), useProjectsControllerGetFiles: mock.files, projectsControllerGetById: mock.fresh, projectsControllerUpdate: mock.update, projectsControllerPresignFile: mock.presign, projectsControllerCompleteFile: mock.complete, projectsControllerRemoveFile: mock.remove }));
const project = { id: 'project', name: 'Perimeter', instruction: 'Original' } as ProjectViewDto;
function show(canEdit = true) {
  return render(<QueryClientProvider client={new QueryClient()}><ProjectAgentContext project={project} workspaceId="workspace" canEdit={canEdit} canChat /></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); mock.workspace = 'workspace'; mock.files.mockReturnValue({ data: [], refetch: vi.fn() }); mock.fresh.mockResolvedValue(project); mock.update.mockResolvedValue({ ...project, instruction: 'Staging only' }); });
afterEach(() => vi.unstubAllGlobals());
it('saves trimmed instructions through a fresh comparison and preserves the limit', async () => {
  show(); const input = screen.getByLabelText('Instructions');
  expect(input).toHaveAttribute('maxLength', '2000');
  fireEvent.change(input, { target: { value: ' Staging only ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalledWith('project', { instruction: 'Staging only' }));
});
it('does not overwrite instructions changed by another member', async () => {
  mock.fresh.mockResolvedValue({ ...project, instruction: 'Changed elsewhere' });
  show(); fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'My draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/changed/i);
  expect(mock.update).not.toHaveBeenCalled(); expect(screen.getByLabelText('Instructions')).toHaveValue('My draft');
});
it('lists files while keeping read-only members from writing', () => {
  mock.files.mockReturnValue({ data: [{ id: 'file', name: 'scope.md', sizeBytes: 10 }] });
  show(false); expect(screen.getByText('scope.md')).toBeVisible();
  expect(screen.getByLabelText('Instructions')).toBeDisabled();
  expect(screen.queryByRole('button', { name: /Detach/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Upload file/ })).toBeNull();
});
it('prevents another upload when five files are attached', () => {
  mock.files.mockReturnValue({ data: Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: `scope-${i}.md`, sizeBytes: 10 })) });
  show(); expect(screen.getByRole('button', { name: 'Upload file' })).toBeDisabled();
});

it('retains a null editing baseline after a background project refresh', async () => {
  const client = new QueryClient();
  const card = (instruction: string | null) => <QueryClientProvider client={client}><ProjectAgentContext project={{ ...project, instruction }} workspaceId="workspace" canEdit canChat /></QueryClientProvider>;
  mock.fresh.mockResolvedValue({ ...project, instruction: 'A colleague edited it' });
  const view = render(card(null));
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'My draft' } });
  view.rerender(card('A colleague edited it'));
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Instructions changed');
  expect(mock.update).not.toHaveBeenCalled();
});

it('keeps writes blocked across remounts and invalidates captured queries when a late save succeeds', async () => {
  let release!: () => void;
  mock.remove.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  mock.files.mockReturnValue({ data: [{ id: 'file', name: 'scope.md', sizeBytes: 1 }] });
  const client = new QueryClient(); const invalidate = vi.spyOn(client, 'invalidateQueries');
  const card = () => <QueryClientProvider client={client}><ProjectAgentContext project={project} workspaceId="workspace" canEdit canChat /></QueryClientProvider>;
  const first = render(card()); fireEvent.click(screen.getByRole('button', { name: 'Detach scope.md' }));
  await waitFor(() => expect(mock.remove).toHaveBeenCalledTimes(1));
  first.unmount(); render(card());
  expect(screen.getByRole('button', { name: 'Detach scope.md' })).toBeDisabled();
  release(); await waitFor(() => expect(screen.getByRole('button', { name: 'Detach scope.md' })).toBeEnabled());
  expect(invalidate).toHaveBeenCalled(); expect(mock.remove).toHaveBeenCalledTimes(1);
});

it('retains an uncertain failure across remounts until a successful explicit refresh', async () => {
  mock.remove.mockRejectedValue(new Error('Response lost after commit'));
  mock.files.mockReturnValue({ data: [{ id: 'file', name: 'scope.md', sizeBytes: 1 }], refetch: vi.fn().mockResolvedValue({ isError: false }) });
  const client = new QueryClient(); const card = () => <QueryClientProvider client={client}><ProjectAgentContext project={project} workspaceId="workspace" canEdit canChat /></QueryClientProvider>;
  const first = render(card()); fireEvent.click(screen.getByRole('button', { name: 'Detach scope.md' }));
  await screen.findByRole('alert'); first.unmount(); render(card());
  expect(screen.getByRole('alert')).toHaveTextContent('Response lost');
  expect(screen.getByRole('button', { name: 'Detach scope.md' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Detach scope.md' })).toBeEnabled());
});

it('stops the upload pipeline if the workspace changes while presigning', async () => {
  let release!: (value: object) => void;
  mock.presign.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  show(); fireEvent.change(screen.getByLabelText('Upload a project file'), { target: { files: [new File(['notes'], 'scope.txt')] } });
  await waitFor(() => expect(mock.presign).toHaveBeenCalledTimes(1));
  mock.workspace = 'another'; release({ artifactId: 'file', url: 'http://storage.invalid', fields: {} });
  await waitFor(() => expect(mock.complete).not.toHaveBeenCalled());
  expect(fetch).not.toHaveBeenCalled();
});

it('uploads the selected bytes, then completes the receipt and supports detach', async () => {
  mock.presign.mockResolvedValue({ artifactId: 'file', url: 'http://storage.invalid', fields: { key: 'staging' } });
  mock.complete.mockResolvedValue([]);
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
  show(); fireEvent.change(screen.getByLabelText('Upload a project file'), { target: { files: [new File(['notes'], 'scope.txt')] } });
  await waitFor(() => expect(mock.complete).toHaveBeenCalledWith('project', 'file'));
  expect(fetch.mock.calls[0][1].body.get('key')).toBe('staging');
  expect(fetch.mock.calls[0][1].body.get('file').name).toBe('scope.txt');
});

it('rejects a non-text file before presigning and never replays an offline mutation', async () => {
  show(); fireEvent.change(screen.getByLabelText('Upload a project file'), { target: { files: [new File(['image'], 'scope.png')] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose a Markdown');
  expect(mock.presign).not.toHaveBeenCalled();
});
it('locks the editor while loading saved instructions so a late read cannot replace a new draft', async () => {
  let release!: (value: ProjectViewDto) => void;
  mock.fresh.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  show(); fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Old draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load saved instructions' }));
  expect(screen.getByLabelText('Instructions')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Save instructions' })).toBeDisabled();
  release(project);
  await waitFor(() => expect(screen.getByLabelText('Instructions')).not.toHaveAttribute('readonly'));
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'New draft' } });
  expect(screen.getByLabelText('Instructions')).toHaveValue('New draft');
});
it('explains a server archive rejection and retains the unsaved instructions', async () => {
  mock.update.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { message: 'Project is archived' } } });
  show(); fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Unsaved draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Project is archived');
  expect(screen.getByLabelText('Instructions')).toHaveValue('Unsaved draft');
});
