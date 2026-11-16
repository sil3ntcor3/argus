import { server } from '@/test/mocks/node';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { parse } from 'yaml';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowsPage } from './project-workflows-page';

const mock = vi.hoisted(() => ({
  project: vi.fn(),
  workflows: vi.fn(),
  permission: vi.fn(),
  triggers: vi.fn(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: mock.permission }));
vi.mock('@/hooks/useWorkspaceSelector', () => ({
  useWorkspaceState: () => ({ state: { selectedWorkspaceId: 'fixture' } }),
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetById: mock.project,
  useProjectsControllerGetWorkflows: mock.workflows,
  useProjectsControllerGetTriggers: mock.triggers,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
    'aria-label': label,
  }: {
    to: string;
    params: { id: string };
    children: ReactNode;
    'aria-label'?: string;
  }) => (
    <a href={to.replace('$id', params.id)} aria-label={label}>
      {children}
    </a>
  ),
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const runId = 'e13a3774-14bc-42bb-8d64-46c3680a57aa';

describe('ProjectWorkflowsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.workflows.mockImplementation(() => ({ ...mock.project(), data: mock.project().data?.assetGroupWorkflows }));
    mock.triggers.mockReturnValue({ data: [] });
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => ['group.read', 'job.read'].includes(key),
    });
    mock.project.mockReturnValue({
      data: {
        assetGroupWorkflows: [
          {
            id: 'binding-1',
            workflow: {
              name: 'Discovery',
              content: {
                name: 'Old label',
                jobs: {
                  consume: { run: 'httpx', needs: ['scan'] },
                  scan: { run: 'naabu' },
                },
              },
            },
            schedule: '0 8 * 1 *',
            lastRun: {
              id: runId,
              status: 'completed',
              createdAt: '2026-11-02T00:00:00Z',
            },
          },
          {
            id: 'binding-2',
            workflow: { content: { name: 'Manual scan' } },
            schedule: 'disabled',
          },
        ],
      },
    });
  });

  it('shows saved labels, schedules and accessible run detail links', () => {
    render(<ProjectWorkflowsPage projectId={projectId.toUpperCase()} />);
    expect(mock.project).toHaveBeenCalledWith(projectId, expect.anything());
    expect(screen.getByRole('heading', { name: 'Discovery' })).toBeVisible();
    expect(screen.getByText('0 8 * 1 * UTC')).toBeVisible();
    expect(screen.getByText('Schedule disabled')).toBeVisible();
    expect(
      screen.getByRole('link', { name: /latest run for Discovery/i }),
    ).toHaveAttribute('href', '/jobs/runs/' + runId);
    expect(screen.getByText('No run summary available')).toBeVisible();
  });
  it('keeps archived workflows readable and hides their write and run controls', () => {
    mock.permission.mockReturnValue({ hasPermission: () => true });
    mock.project().data.archivedAt = '2026-11-13T10:00:00Z';
    render(<QueryClientProvider client={new QueryClient()}><ProjectWorkflowsPage projectId={projectId} /></QueryClientProvider>);
    expect(screen.getByRole('heading', { name: 'Discovery' })).toBeVisible();
    expect(screen.getByText(/Archived project/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create workflow' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run workflow for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit schedule/ })).toBeNull();
  });

  it('offers rename only for editable workflows owned by this project', () => {
    mock.permission.mockReturnValue({ hasPermission: () => true });
    const data = mock.project().data;
    const workflow = data.assetGroupWorkflows[0].workflow;
    Object.assign(workflow, {
      id: runId,
      isCanEdit: true,
      isCanDelete: true,
      filePath: `project-${projectId}-pipeline.yaml`,
    });
    data.assetGroupWorkflows.push(
      {
        id: 'shared',
        workflow: { ...workflow, name: 'Shared', filePath: 'shared.yaml' },
        schedule: 'disabled',
      },
      {
        id: 'locked',
        workflow: { ...workflow, name: 'Locked', isCanEdit: false },
        schedule: 'disabled',
      },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectWorkflowsPage projectId={projectId} />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole('button', { name: 'Rename workflow Discovery' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit pipeline for Discovery' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit pipeline for Shared' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Rename workflow Shared' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Rename workflow Locked' }),
    ).toBeNull();
  });

  it('shows run evidence without a link when job read is absent', () => {
    mock.permission.mockReturnValue({
      hasPermission: (key: string) => key === 'project.read',
    });
    render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.queryByRole('link', { name: /latest run/i })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /run workflow for/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Create workflow' }),
    ).toBeNull();
  });

  it('opens the selected workflow as YAML in dependency order and restores focus', async () => {
    render(<ProjectWorkflowsPage projectId={projectId} />);
    const trigger = screen.getByRole('button', {
      name: 'View workflow for Discovery',
    });
    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Workflow definition' });
    const source = sheet.querySelector('pre')?.textContent ?? '';
    expect(parse(source)).toEqual({
      name: 'Old label',
      jobs: {
        scan: { run: 'naabu' },
        consume: { run: 'httpx', needs: ['scan'] },
      },
    });
    expect(source.indexOf('scan:')).toBeLessThan(source.indexOf('consume:'));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('loads templates on demand and prevents a retry after an ambiguous create response', async () => {
    const catalog = vi.fn();
    const create = vi.fn();
    server.use(
      http.get('/api/projects/workflow-templates', () => {
        catalog();
        return HttpResponse.json([
          { filePath: 'probe.yaml', name: 'Probe', jobs: [] },
        ]);
      }),
      http.post('/api/projects/:id/workflows', async ({ request }) => {
        create(await request.json());
        return HttpResponse.json({}, { status: 502 });
      }),
    );
    mock.permission.mockReturnValue({
      hasPermission: (key: string) =>
        ['project.read', 'group.write'].includes(key),
    });
    setGlobalWorkspaceId('fixture');
    try {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ProjectWorkflowsPage projectId={projectId} />
        </QueryClientProvider>,
      );
      expect(catalog).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }));
      const dialog = within(
        screen.getByRole('dialog', { name: 'Create project workflow' }),
      );
      const submit = dialog.getByRole('button', { name: 'Create workflow' });
      expect(submit).toBeDisabled();
      await dialog.findByRole('option', { name: 'Probe' });
      fireEvent.change(dialog.getByLabelText('Workflow template'), {
        target: { value: 'probe.yaml' },
      });
      submit.focus();
      fireEvent.click(submit);
      expect(await dialog.findByRole('alert')).toHaveTextContent(
        'may have created',
      );
      expect(submit).toHaveAttribute('aria-disabled', 'true');
      expect(submit).toHaveFocus();
      fireEvent.click(submit);
      expect(create).toHaveBeenCalledExactlyOnceWith({
        template: 'probe.yaml',
      });
    } finally {
      setGlobalWorkspaceId(null);
    }
  });

  it('keeps the pending action focused and blocks duplicates across remounts', async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = vi.fn();
    server.use(
      http.get('/api/projects/workflow-templates', () =>
        HttpResponse.json([
          { filePath: 'probe.yaml', name: 'Probe', jobs: [] },
        ]),
      ),
      http.post('/api/projects/:id/workflows', async () => {
        create();
        await pending;
        return HttpResponse.json({}, { status: 400 });
      }),
    );
    mock.permission.mockReturnValue({
      hasPermission: (key: string) =>
        ['project.read', 'project.write'].includes(key),
    });
    setGlobalWorkspaceId('fixture');
    const client = new QueryClient();
    const show = () =>
      render(
        <QueryClientProvider client={client}>
          <ProjectWorkflowsPage projectId={projectId} />
        </QueryClientProvider>,
      );
    try {
      const first = show();
      fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }));
      const dialog = within(screen.getByRole('dialog'));
      await dialog.findByRole('option', { name: 'Probe' });
      fireEvent.change(dialog.getByLabelText('Workflow template'), {
        target: { value: 'probe.yaml' },
      });
      const submit = dialog.getByRole('button', { name: 'Create workflow' });
      submit.focus();
      fireEvent.click(submit);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(submit).toHaveFocus();
      first.unmount();

      show();
      const trigger = screen.getByRole('button', {
        name: 'Creating workflow…',
      });
      expect(trigger).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(trigger);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(create).toHaveBeenCalledTimes(1);
      finish();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Create workflow' }),
        ).toBeEnabled(),
      );
    } finally {
      finish();
      setGlobalWorkspaceId(null);
    }
  });

  it('does not query when project access is missing', () => {
    mock.permission.mockReturnValue({ hasPermission: () => false });
    render(<ProjectWorkflowsPage projectId={projectId} />);
    expect(mock.project).not.toHaveBeenCalled();
  });
});
