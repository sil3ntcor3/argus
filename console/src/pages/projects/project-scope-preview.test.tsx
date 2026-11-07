import type { ScopeRuleDto } from '@/services/apis/gen/queries';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { ProjectScopePreview } from './project-scope-preview';

const mock = vi.hoisted(() => ({
  preview: vi.fn(),
  save: vi.fn(),
  latest: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  projectsControllerGetScopeRules: mock.latest,
  useProjectsControllerPreviewScope: mock.preview,
  useProjectsControllerReplaceScopeRules: mock.save,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: mock.workspace,
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const rule: ScopeRuleDto = {
  id: 'ed5cfdd9-189e-49cf-a3d1-4f8a3e0a565d',
  mode: 'include',
  type: 'hostname',
  value: '*.argus.test',
  label: '*.argus.test',
  matched: 2,
};

function renderPreview(props: ComponentProps<typeof ProjectScopePreview>) {
  const client = new QueryClient();
  return render(<ProjectScopePreview {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview scope' }));
  return within(screen.getByRole('dialog', { name: 'Preview project scope' }));
}

describe('ProjectScopePreview', () => {
  beforeEach(() => {
    mock.workspace.mockReset().mockReturnValue('original-workspace');
    mock.preview.mockReset();
    mock.save.mockReset().mockReturnValue({ mutateAsync: vi.fn() });
    mock.latest
      .mockReset()
      .mockResolvedValue({ rules: [rule], autoAddAssets: true });
  });

  it('seeds a draft and previews edited rules against the current project', () => {
    const reset = vi.fn();
    const mutate = vi.fn();
    mock.preview.mockReturnValue({ reset, mutate });
    renderPreview({ projectId, rules: [rule] });
    expect(mock.preview).not.toHaveBeenCalled();
    const sheet = open();
    const value = sheet.getByRole('textbox', { name: 'Rule value' });
    expect(value).toHaveValue('*.argus.test');
    fireEvent.change(value, { target: { value: '*.demo.argus.test' } });
    expect(reset).toHaveBeenCalledOnce();
    const preview = sheet.getByRole('button', { name: 'Preview matches' });
    fireEvent.click(preview);
    expect(preview).toHaveFocus();
    expect(mutate).toHaveBeenCalledWith({
      data: {
        projectId,
        rules: [
          { mode: 'include', type: 'hostname', value: '*.demo.argus.test' },
        ],
      },
    });
  });

  it('shows the API preview counts alongside the draft rules', () => {
    mock.preview.mockReturnValue({
      reset: vi.fn(),
      data: { total: 3, ruleAssets: 2, perRule: [2] },
    });
    renderPreview({ projectId, rules: [rule] });
    const sheet = open();
    expect(sheet.getByRole('status')).toHaveTextContent(
      '3 assets in scope, including 2 matched by rules.',
    );
    expect(sheet.getByText('2 matched')).toBeVisible();
    fireEvent.click(sheet.getByRole('button', { name: 'Add rule' }));
    const added = within(sheet.getByRole('group', { name: 'Rule 2' }));
    expect(added.getByRole('textbox', { name: 'Rule value' })).toHaveFocus();
  });

  it('shows the endpoint limit for projects with more than 100 stored rules', () => {
    const rules = Array.from({ length: 101 }, (_, index) => ({
      ...rule,
      id: String(index),
    }));
    renderPreview({ projectId, rules });
    expect(
      screen.getByText('Scope preview supports up to 100 rules.'),
    ).toBeVisible();
    expect(mock.preview).not.toHaveBeenCalled();
  });
  it('requires a current preview and writes the edited draft and preference', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ added: 1, removed: 0 });
    const reset = vi.fn(() => mock.preview.mockReturnValue({ reset }));
    mock.preview.mockReturnValue({ reset });
    mock.save.mockReturnValue({ mutateAsync });
    const props = {
      projectId,
      rules: [rule],
      canEdit: true,
      autoAddAssets: true,
    };
    const { rerender } = renderPreview(props);
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    const editor = within(
      screen.getByRole('dialog', { name: 'Edit project scope' }),
    );
    const save = editor.getByRole('button', { name: 'Save scope' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(save);
    expect(mock.latest).not.toHaveBeenCalled();

    const result = { total: 3, ruleAssets: 2, perRule: [2] };
    mock.preview.mockReturnValue({ reset, data: result });
    rerender(<ProjectScopePreview {...props} />);
    fireEvent.change(editor.getByRole('textbox', { name: 'Rule value' }), {
      target: { value: '*.demo.argus.test' },
    });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(save);
    expect(mock.latest).not.toHaveBeenCalled();

    mock.preview.mockReturnValue({ reset, data: result });
    rerender(<ProjectScopePreview {...props} />);
    fireEvent.click(
      editor.getByRole('checkbox', {
        name: 'Automatically add newly discovered matching assets',
      }),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        id: projectId,
        data: {
          rules: [
            { mode: 'include', type: 'hostname', value: '*.demo.argus.test' },
          ],
          autoAddAssets: false,
        },
      }),
    );
  });

  it('rejects a draft when the current server scope has changed', async () => {
    const mutateAsync = vi.fn();
    mock.save.mockReturnValue({ mutateAsync });
    mock.preview.mockReturnValue({
      data: { total: 3, ruleAssets: 2, perRule: [2] },
    });
    mock.latest.mockResolvedValue({
      rules: [{ ...rule, value: '*.other.argus.test' }],
      autoAddAssets: true,
    });
    renderPreview({
      projectId,
      rules: [rule],
      canEdit: true,
      autoAddAssets: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));
    expect(
      await screen.findByText(
        'Saved scope changed. Reopen the editor to load it.',
      ),
    ).toBeVisible();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
  it('keeps the dialog open while verifying and drops a save after workspace changes', async () => {
    const mutateAsync = vi.fn();
    const result = { rules: [rule], autoAddAssets: true };
    let complete: (response: typeof result) => void = () => undefined;
    mock.latest.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    mock.save.mockReturnValue({ mutateAsync });
    mock.preview.mockReturnValue({
      data: { total: 3, ruleAssets: 2, perRule: [2] },
    });
    renderPreview({
      projectId,
      rules: [rule],
      canEdit: true,
      autoAddAssets: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit project scope' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save scope' }));
    expect(
      within(dialog).getByRole('button', { name: 'Saving…' }),
    ).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeVisible();
    mock.workspace.mockReturnValue('other-workspace');
    complete(result);
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Save scope' }),
      ).toBeVisible(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
