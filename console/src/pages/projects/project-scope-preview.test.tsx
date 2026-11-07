import type { ScopeRuleDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectScopePreview } from './project-scope-preview';

const mock = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerPreviewScope: mock.preview,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const rule: ScopeRuleDto = {
  id: 'ed5cfdd9-189e-49cf-a3d1-4f8a3e0a565d',
  mode: 'include',
  type: 'hostname',
  value: '*.argus.test',
  label: '*.argus.test',
  matched: 2,
};

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview scope' }));
  return within(screen.getByRole('dialog', { name: 'Preview project scope' }));
}

describe('ProjectScopePreview', () => {
  beforeEach(() => {
    mock.preview.mockReset();
  });

  it('seeds a draft and previews edited rules against the current project', () => {
    const reset = vi.fn();
    const mutate = vi.fn();
    mock.preview.mockReturnValue({ reset, mutate });
    render(<ProjectScopePreview projectId={projectId} rules={[rule]} />);
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
    render(<ProjectScopePreview projectId={projectId} rules={[rule]} />);
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
    render(<ProjectScopePreview projectId={projectId} rules={rules} />);
    expect(
      screen.getByText('Scope preview supports up to 100 rules.'),
    ).toBeVisible();
    expect(mock.preview).not.toHaveBeenCalled();
  });
});
