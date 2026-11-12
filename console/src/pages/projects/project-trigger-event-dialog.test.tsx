import { server } from '@/test/mocks/node';
import {
  getGlobalWorkspaceId,
  setGlobalWorkspaceId,
} from '@/utils/workspaceState';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    hasPermission: (key: string) =>
      ['project.read', 'project.write'].includes(key),
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
const post = vi.fn();
let rows: Record<string, unknown>[];
let otherWorkflows: {
  id: string;
  schedule: string;
  workflow: { name: string };
}[];
/** Render the real page, permission gate and creation hook together. */
async function open() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProjectWorkflowsPage projectId={projectId} />
    </QueryClientProvider>,
  );
  const trigger = await screen.findByRole('button', {
    name: 'Add event trigger for Discovery',
  });
  fireEvent.click(trigger);
  const dialog = within(
    screen.getByRole('dialog', { name: 'Add event trigger' }),
  );
  return {
    trigger,
    dialog,
    submit: dialog.getByRole('button', { name: 'Add disabled trigger' }),
    event: dialog.getByRole('combobox', { name: 'Event' }),
  };
}

describe('Project event trigger creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    rows = [];
    otherWorkflows = [];
    setGlobalWorkspaceId('fixture');
    server.use(
      http.get('/api/projects/:id', () =>
        HttpResponse.json({
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
                content: {
                  name: 'Discovery',
                  jobs: { probe: { run: 'httpx' } },
                },
              },
            },
            ...otherWorkflows,
          ],
        }),
      ),
      http.get('/api/projects/:id/triggers', () => HttpResponse.json(rows)),
      http.post('/api/projects/:id/triggers', async ({ request }) => {
        const data = (await request.json()) as Record<string, unknown>;
        post(data, request.headers.get('X-Workspace-Id'));
        const created = {
          ...data,
          id: 'trigger',
          enabled: false,
          lastFiredAt: null,
        };
        rows.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    );
  });
  afterEach(() => {
    setGlobalWorkspaceId(null);
    vi.unstubAllGlobals();
  });

  it.each([
    ['project.assets.added', 'New assets matching', 'When assets are added'],
    [
      'project.run.completed',
      'Assets scanned by matching runs',
      'After a project workflow finishes',
    ],
    [
      'vulnerability.detected',
      'Assets with matching findings',
      'When a vulnerability is found',
    ],
  ])(
    'creates disabled %s with visible defaults and refreshes the list',
    async (event, hint, label) => {
      const form = await open();
      fireEvent.change(form.event, { target: { value: event } });
      expect(form.dialog.getByText(hint, { exact: false })).toBeVisible();
      fireEvent.click(form.submit);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(post).toHaveBeenCalledExactlyOnceWith(
        {
          projectWorkflowId: bindingId,
          type: 'event',
          event,
          config: { windowMinutes: 10, maxAssets: 200 },
        },
        'fixture',
      );
      expect(screen.getByText(label, { exact: true })).toBeVisible();
      expect(screen.getByText('Disabled', { exact: true })).toBeVisible();
      await waitFor(() => expect(form.trigger).toHaveFocus());
    },
  );

  it.each([
    ['Gather for (minutes)', ''],
    ['Gather for (minutes)', '-1'],
    ['Gather for (minutes)', '1441'],
    ['Gather for (minutes)', '1.5'],
    ['Most assets per batch', '0'],
    ['Most assets per batch', '5001'],
    ['Most assets per batch', '1.5'],
  ])('rejects invalid %s: %s before HTTP', async (label, value) => {
    const form = await open();
    fireEvent.change(form.dialog.getByRole('spinbutton', { name: label }), {
      target: { value },
    });
    expect(form.submit).toBeDisabled();
    fireEvent.submit(form.submit.closest('form')!);
    expect(post).not.toHaveBeenCalled();
  });

  it('retains deterministic errors and sends whole-number boundary settings', async () => {
    server.use(
      http.post('/api/projects/:id/triggers', () => {
        post();
        return HttpResponse.json({}, { status: 400 });
      }),
    );
    const form = await open();
    fireEvent.change(form.event, {
      target: { value: 'vulnerability.detected' },
    });
    fireEvent.change(
      form.dialog.getByRole('spinbutton', { name: 'Gather for (minutes)' }),
      { target: { value: '0' } },
    );
    fireEvent.change(
      form.dialog.getByRole('spinbutton', { name: 'Most assets per batch' }),
      { target: { value: '5000' } },
    );
    fireEvent.click(form.submit);
    expect(await form.dialog.findByRole('alert')).toHaveTextContent(
      'Could not add event trigger',
    );
    expect(form.event).toHaveValue('vulnerability.detected');
    expect(
      form.dialog.getByRole('spinbutton', { name: 'Most assets per batch' }),
    ).toHaveValue(5000);
    server.use(
      http.post('/api/projects/:id/triggers', async ({ request }) => {
        post(await request.json());
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    fireEvent.click(form.submit);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith({
      projectWorkflowId: bindingId,
      type: 'event',
      event: 'vulnerability.detected',
      config: { windowMinutes: 0, maxAssets: 5000 },
    });
  });

  it('keeps uncertain errors after edits and blocks repeat submissions', async () => {
    server.use(
      http.post('/api/projects/:id/triggers', () => {
        post();
        return HttpResponse.json({}, { status: 502 });
      }),
    );
    const form = await open();
    fireEvent.click(form.submit);
    expect(await form.dialog.findByRole('alert')).toHaveTextContent(
      'may have been added',
    );
    fireEvent.change(form.event, {
      target: { value: 'vulnerability.detected' },
    });
    fireEvent.change(
      form.dialog.getByRole('spinbutton', { name: 'Gather for (minutes)' }),
      { target: { value: '0' } },
    );
    expect(form.submit).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(form.submit);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends selected target types without leaking hidden event settings', async () => {
    const form = await open();
    fireEvent.click(form.dialog.getByRole('checkbox', { name: 'Domains' }));
    fireEvent.click(form.dialog.getByRole('checkbox', { name: 'IPs' }));
    fireEvent.change(form.event, {
      target: { value: 'vulnerability.detected' },
    });
    fireEvent.click(form.dialog.getByRole('checkbox', { name: 'Medium' }));
    fireEvent.change(form.event, { target: { value: 'project.assets.added' } });
    fireEvent.click(form.submit);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(
      {
        projectWorkflowId: bindingId,
        type: 'event',
        event: 'project.assets.added',
        config: {
          windowMinutes: 10,
          maxAssets: 200,
          targetTypes: ['DOMAIN', 'IP'],
        },
      },
      'fixture',
    );
  });

  it('offers other project workflows and sends the selected failure outcome', async () => {
    otherWorkflows = [
      { id: 'other', schedule: 'disabled', workflow: { name: 'Recon' } },
    ];
    const form = await open();
    fireEvent.change(form.event, {
      target: { value: 'project.run.completed' },
    });
    const followed = within(
      form.dialog.getByRole('group', { name: 'After workflows' }),
    );
    expect(followed.queryByRole('checkbox', { name: 'Discovery' })).toBeNull();
    fireEvent.click(followed.getByRole('checkbox', { name: 'Recon' }));
    fireEvent.click(form.dialog.getByRole('checkbox', { name: 'Succeeded' }));
    expect(form.submit).toBeDisabled();
    fireEvent.click(form.dialog.getByRole('checkbox', { name: 'Failed' }));
    fireEvent.click(form.submit);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(
      {
        projectWorkflowId: bindingId,
        type: 'event',
        event: 'project.run.completed',
        config: {
          windowMinutes: 10,
          maxAssets: 200,
          workflows: ['Recon'],
          status: ['failure'],
        },
      },
      'fixture',
    );
  });

  it('requires a finding severity and retains its draft across event changes', async () => {
    const form = await open();
    fireEvent.change(form.event, {
      target: { value: 'vulnerability.detected' },
    });
    for (const name of ['Critical', 'High'])
      fireEvent.click(form.dialog.getByRole('checkbox', { name }));
    expect(form.submit).toBeDisabled();
    fireEvent.click(form.dialog.getByRole('checkbox', { name: 'Medium' }));
    fireEvent.change(form.event, {
      target: { value: 'project.run.completed' },
    });
    fireEvent.change(form.event, {
      target: { value: 'vulnerability.detected' },
    });
    expect(form.dialog.getByRole('checkbox', { name: 'Medium' })).toBeChecked();
    expect(
      form.dialog.getByRole('checkbox', { name: 'Critical' }),
    ).not.toBeChecked();
    fireEvent.click(form.submit);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(
      {
        projectWorkflowId: bindingId,
        type: 'event',
        event: 'vulnerability.detected',
        config: { windowMinutes: 10, maxAssets: 200, severity: ['medium'] },
      },
      'fixture',
    );
  });

  it('enforces the API limit of twenty followed workflow names', async () => {
    otherWorkflows = Array.from({ length: 21 }, (_, index) => ({
      id: `other-${index}`,
      schedule: 'disabled',
      workflow: { name: `Workflow ${index}` },
    }));
    const form = await open();
    fireEvent.change(form.event, {
      target: { value: 'project.run.completed' },
    });
    const choices = within(
      form.dialog.getByRole('group', { name: 'After workflows' }),
    ).getAllByRole('checkbox');
    for (const choice of choices) fireEvent.click(choice);
    expect(form.submit).toBeDisabled();
    expect(form.dialog.getByText(/up to 20/)).toBeVisible();
    fireEvent.submit(form.submit.closest('form')!);
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(choices[20]);
    expect(form.submit).toBeEnabled();
  });

  it('retains filters on errors and resets them on a new dialog', async () => {
    server.use(
      http.post('/api/projects/:id/triggers', () =>
        HttpResponse.json({}, { status: 400 }),
      ),
    );
    const form = await open();
    fireEvent.click(form.dialog.getByRole('checkbox', { name: 'IPs' }));
    fireEvent.click(form.submit);
    await form.dialog.findByRole('alert');
    expect(form.dialog.getByRole('checkbox', { name: 'IPs' })).toBeChecked();
    fireEvent.click(form.dialog.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(form.trigger);
    expect(screen.getByRole('checkbox', { name: 'IPs' })).not.toBeChecked();
  });
});
