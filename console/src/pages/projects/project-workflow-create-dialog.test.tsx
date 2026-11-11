import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/node';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { getToolsControllerGetInstalledToolsQueryKey } from '@/services/apis/gen/queries';
import type { PipelineToolEntry } from '@/pages/asset-group/components/tool-pipeline-builder';
import { ProjectWorkflowCreateDialog } from './project-workflow-create-dialog';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
vi.mock('@/pages/asset-group/components/tool-pipeline-builder', () => ({
  isPipelineValid: () => true,
  ToolPipelineBuilder: ({
    value,
    onChange,
    disabled,
    allowInstall,
  }: {
    value: PipelineToolEntry[];
    onChange: (next: PipelineToolEntry[]) => void;
    disabled: boolean;
    allowInstall: boolean;
  }) => (
    <>
      <input aria-label="Installed tool search" />
      <input aria-label="Install tool search" />
      <pre aria-label="Draft">{JSON.stringify(value)}</pre>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onChange([
            { toolId: 'ports', stage: 1, input: ['host'] },
            { toolId: 'web', stage: 2 },
          ])
        }
      >
        {allowInstall ? 'Select pipeline with installer' : 'Select pipeline'}
      </button>
    </>
  ),
}));

const tools = [
  { id: 'ports', name: 'naabu' },
  { id: 'web', name: 'httpx' },
];
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkflowCreateDialog projectId="project" workspaceId="fixture" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }));
  const dialog = within(
    screen.getByRole('dialog', { name: 'Create project workflow' }),
  );
  fireEvent.change(dialog.getByLabelText('Creation source'), {
    target: { value: 'tools' },
  });
  return {
    client,
    dialog,
    submit: dialog.getByRole('button', {
      name: 'Create workflow',
    }),
  };
}

describe('Project workflow tools creation', () => {
  beforeEach(() => {
    setGlobalWorkspaceId('fixture');
    server.use(
      http.get('/api/projects/workflow-templates', () => HttpResponse.json([])),
      http.get('/api/tools/installed', () =>
        HttpResponse.json({ data: tools }),
      ),
    );
  });

  it('prevents search Enter from implicitly submitting, while retaining name-field keyboard behavior', async () => {
    const { client, dialog } = show();
    await dialog.findByRole('button', {
      name: 'Select pipeline with installer',
    });
    for (const label of ['Installed tool search', 'Install tool search'])
      expect(
        fireEvent.keyDown(dialog.getByLabelText(label), { key: 'Enter' }),
      ).toBe(false);
    expect(
      fireEvent.keyDown(dialog.getByLabelText('Workflow name (optional)'), {
        key: 'Enter',
      }),
    ).toBe(true);
    client.clear();
  });

  it('keeps the selected pipeline and name across catalog refresh and creates only jobs', async () => {
    const create = vi.fn();
    server.use(
      http.post('/api/projects/:id/workflows', async ({ request }) => {
        create(await request.json());
        return HttpResponse.json({ id: 'binding' }, { status: 201 });
      }),
    );
    const { client, dialog, submit } = show();
    expect(submit).toBeDisabled();
    fireEvent.click(
      await dialog.findByRole('button', {
        name: 'Select pipeline with installer',
      }),
    );
    fireEvent.change(dialog.getByLabelText('Workflow name (optional)'), {
      target: { value: '  Chosen scan  ' },
    });
    await act(() =>
      client.invalidateQueries({
        queryKey: getToolsControllerGetInstalledToolsQueryKey(),
      }),
    );
    expect(dialog.getByLabelText('Draft')).toHaveTextContent('ports');
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(create).toHaveBeenCalledExactlyOnceWith({
        name: 'Chosen scan',
        jobs: {
          naabu: { run: 'naabu', input: ['host'] },
          httpx: { run: 'httpx', needs: ['naabu'] },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    client.clear();
  });

  it.each([400, 502])(
    'preserves drafts after HTTP %s and prevents ambiguous retries',
    async (status) => {
      const create = vi.fn();
      server.use(
        http.post('/api/projects/:id/workflows', () => {
          create();
          return HttpResponse.json({ message: 'Try again' }, { status });
        }),
      );
      const { client, dialog, submit } = show();
      fireEvent.click(
        await dialog.findByRole('button', {
          name: 'Select pipeline with installer',
        }),
      );
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.click(submit);
      await dialog.findByRole('alert');
      expect(dialog.getByLabelText('Draft')).toHaveTextContent('ports');
      if (status === 502) {
        expect(dialog.getByLabelText('Creation source')).toBeDisabled();
        expect(submit).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(submit);
        expect(create).toHaveBeenCalledTimes(1);
      } else {
        fireEvent.click(submit);
        await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      }
      client.clear();
    },
  );

  it('supports tool-catalog retry and blocks submission after a workspace switch', async () => {
    let failed = true;
    const create = vi.fn();
    server.use(
      http.get('/api/tools/installed', () =>
        failed
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ data: tools }),
      ),
      http.post('/api/projects/:id/workflows', () => {
        create();
        return HttpResponse.json({ id: 'binding' });
      }),
    );
    const { client, dialog, submit } = show();
    await dialog.findByText('Unable to load tools.');
    expect(submit).toBeDisabled();
    failed = false;
    fireEvent.click(dialog.getByRole('button', { name: 'Retry tools' }));
    fireEvent.click(
      await dialog.findByRole('button', {
        name: 'Select pipeline with installer',
      }),
    );
    await waitFor(() => expect(submit).toBeEnabled());
    setGlobalWorkspaceId('elsewhere');
    fireEvent.click(submit);
    expect(create).not.toHaveBeenCalled();
    client.clear();
    setGlobalWorkspaceId('fixture');
  });
});
