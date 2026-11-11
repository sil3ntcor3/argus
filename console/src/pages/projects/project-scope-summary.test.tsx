import type { ProjectScopeDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectScopeSummary } from './project-scope-summary';

const mock = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetScopeRules: mock.scope,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const scope: ProjectScopeDto = {
  autoAddAssets: true,
  manualAssets: 2,
  ruleAssets: 1,
  rules: [
    {
      id: 'include',
      mode: 'include',
      type: 'hostname',
      value: '*.argus.test',
      label: '*.argus.test',
      matched: 2,
    },
    {
      id: 'exclude',
      mode: 'exclude',
      type: 'asset',
      value: 'ed5cfdd9-189e-49cf-a3d1-4f8a3e0a565d',
      label: 'private.argus.test',
      matched: 1,
    },
  ],
};

describe('ProjectScopeSummary', () => {
  beforeEach(() => {
    mock.scope.mockReset().mockReturnValue({ data: scope });
  });

  it('shows the stored preference, membership counts, and exclusion evidence', () => {
    render(<ProjectScopeSummary projectId={projectId} />);
    const card = within(screen.getByRole('region', { name: 'Project scope' }));
    expect(mock.scope).toHaveBeenCalledWith(projectId, {
      query: { retry: false },
    });
    expect(
      card.getByText(
        'Automatic additions for newly discovered matches are on.',
      ),
    ).toBeVisible();
    expect(card.getByText('2 manual')).toBeVisible();
    expect(card.getByText('1 from rules')).toBeVisible();
    fireEvent.click(card.getByText('Scope rules (2)'));
    expect(card.getByText('private.argus.test')).toBeVisible();
    expect(card.getByText('1 excluded from rule matches')).toBeVisible();
  });

  it('renders one page of rule rows and keeps the rest reachable', () => {
    const rules = Array.from({ length: 41 }, (_, index) => ({
      ...scope.rules[0],
      id: String(index),
      label: `rule-${index}`,
    }));
    mock.scope.mockReturnValue({ data: { ...scope, rules } });
    render(<ProjectScopeSummary projectId={projectId} />);
    fireEvent.click(screen.getByText('Scope rules (41)'));
    const list = within(
      screen.getByRole('list', { name: 'Saved scope rules' }),
    );
    expect(list.getAllByRole('listitem')).toHaveLength(20);
    expect(list.queryByText('rule-40')).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next rules' });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(list.getAllByRole('listitem')).toHaveLength(1);
    expect(list.getByText('rule-40')).toBeVisible();
    expect(next).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows a retry and keeps its focus within the scope card', () => {
    const refetch = vi.fn();
    mock.scope.mockReturnValue({ isError: true, refetch });
    render(<ProjectScopeSummary projectId={projectId} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Unable to load project scope',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry scope' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('heading', { name: 'Project scope' }),
    ).toHaveFocus();
  });

  it('hides stale scope after an access failure', () => {
    mock.scope.mockReturnValue({
      data: scope,
      isError: true,
      error: { isAxiosError: true, response: { status: 403 } },
    });
    render(<ProjectScopeSummary projectId={projectId} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Project scope unavailable',
    );
    expect(screen.queryByText('2 manual')).not.toBeInTheDocument();
  });
});
