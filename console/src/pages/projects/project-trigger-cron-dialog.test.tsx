import { server } from '@/test/mocks/node';
import {
  setGlobalWorkspaceId,
  getGlobalWorkspaceId,
} from '@/utils/workspaceState';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowsPage } from './project-workflows-page';

const access = vi.hoisted(() => ({ write: true }));
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    hasPermission: (key: string) =>
      key === 'project.read' || (access.write && key === 'project.write'),
  }),
}));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({
    state: { selectedWorkspaceId: getGlobalWorkspaceId() },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const bindingId = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';
const created = {
  id: 'trigger',
  projectWorkflowId: bindingId,
  type: 'cron',
  cron: '0 8 * * *',
  enabled: false,
  config: {},
  lastFiredAt: null,
};
const post = vi.fn();
let project: ReturnType<typeof fixture>;
let saved = false;
function fixture() {
  return {
    totalAssets: 0,
    assetGroupWorkflows: [
      {
        id: bindingId,
        schedule: 'disabled',
        workflow: {
          id: bindingId,
          name: 'Discovery',
          filePath: `project-${projectId}-scan.yaml`,
          isCanEdit: true,
          isCanDelete: true,
          content: { name: 'Discovery', jobs: { probe: { run: 'httpx' } } },
        },
      },
    ],
  };
}
function show(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return {
    client,
    view: render(
      <QueryClientProvider client={client}>
        <ProjectWorkflowsPage projectId={projectId} />
      </QueryClientProvider>,
    ),
  };
}
async function open() {
  const result = show();
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Add schedule trigger for Discovery',
    }),
  );
  const dialog = within(
    screen.getByRole('dialog', { name: 'Add schedule trigger' }),
  );
  const input = dialog.getByRole('textbox', { name: 'Cron expression (UTC)' });
  fireEvent.change(input, { target: { value: ' 0  8 * * * ' } });
  return {
    ...result,
    dialog,
    input,
    submit: dialog.getByRole('button', { name: 'Add disabled trigger' }),
  };
}

describe('Project schedule trigger creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.write = true;
    project = fixture();
    saved = false;
    setGlobalWorkspaceId('fixture');
    server.use(
      http.get('/api/projects/:id', () => HttpResponse.json(project)),
      http.get('/api/projects/:id/triggers', () =>
        HttpResponse.json(saved ? [created] : []),
      ),
      http.post('/api/projects/:id/triggers', async ({ request }) => {
        post(await request.json(), request.headers.get('X-Workspace-Id'));
        saved = true;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
  });
  afterEach(() => {
    onlineManager.setOnline(true);
    setGlobalWorkspaceId(null);
  });

  it('normalizes one cron request, refreshes the trigger list, and restores focus', async () => {
    const { submit } = await open();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).toHaveBeenCalledExactlyOnceWith(
      { projectWorkflowId: bindingId, type: 'cron', cron: '0 8 * * *' },
      'fixture',
    );
    expect(await screen.findByTitle('0 8 * * *')).toBeVisible();
    expect(screen.getByText('Disabled', { exact: true })).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Add schedule trigger for Discovery',
        }),
      ).toHaveFocus(),
    );
  });

  it('rejects incomplete input locally and preserves a draft on a deterministic error', async () => {
    server.use(
      http.post('/api/projects/:id/triggers', () => {
        post();
        return HttpResponse.json({}, { status: 400 });
      }),
    );
    const { input, submit, dialog } = await open();
    fireEvent.change(input, { target: { value: '* *' } });
    fireEvent.click(submit);
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0 8 * * *' } });
    fireEvent.click(submit);
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Could not add schedule',
    );
    expect(input).toHaveValue('0 8 * * *');
    server.use(
      http.post('/api/projects/:id/triggers', () => {
        post();
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    fireEvent.change(input, { target: { value: '0 9 * * *' } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([408, 500, 'offline'])(
    'blocks retries after uncertain %s failure, without replaying on reconnect',
    async (status) => {
      server.use(
        http.post('/api/projects/:id/triggers', () => {
          post();
          return status === 'offline'
            ? HttpResponse.error()
            : HttpResponse.json({}, { status: Number(status) });
        }),
      );
      const { submit, dialog } = await open();
      if (status === 'offline') onlineManager.setOnline(false);
      fireEvent.click(submit);
      expect(await dialog.findByRole('alert')).toHaveTextContent(
        'may have been added',
      );
      fireEvent.click(submit);
      onlineManager.setOnline(true);
      await waitFor(() =>
        expect(submit).toHaveAttribute('aria-disabled', 'true'),
      );
      expect(post).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks duplicate clicks and remounts while a request is pending', async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.post('/api/projects/:id/triggers', async () => {
        post();
        await pending;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const { submit, dialog, view, client } = await open();
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    fireEvent.click(submit);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    view.unmount();
    const remount = show(client);
    const trigger = await screen.findByRole('button', {
      name: 'Add schedule trigger for Discovery',
    });
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
    finish();
    await waitFor(() =>
      expect(trigger).toHaveAttribute('aria-disabled', 'false'),
    );
    expect(post).toHaveBeenCalledTimes(1);
    remount.view.unmount();
  });

  it('does not submit after workspace selection changes', async () => {
    const { submit } = await open();
    setGlobalWorkspaceId('other');
    fireEvent.click(submit);
    expect(post).not.toHaveBeenCalled();
  });

  it('reports the existing server archive guard without inventing a read field', async () => {
    server.use(
      http.post('/api/projects/:id/triggers', () =>
        HttpResponse.json({ message: 'Project is archived' }, { status: 400 }),
      ),
    );
    const { submit, dialog } = await open();
    fireEvent.click(submit);
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'This project is archived',
    );
    expect(saved).toBe(false);
  });

  it.each(['read only', 'shared', 'locked'])(
    'hides the action for %s projects or workflows',
    async (reason) => {
      if (reason === 'read only') access.write = false;
      if (reason === 'shared')
        project.assetGroupWorkflows[0].workflow.filePath = 'shared.yaml';
      if (reason === 'locked')
        project.assetGroupWorkflows[0].workflow.isCanEdit = false;
      show();
      await screen.findByRole('heading', { name: 'Discovery' });
      expect(
        screen.queryByRole('button', {
          name: 'Add schedule trigger for Discovery',
        }),
      ).toBeNull();
    },
  );
});
