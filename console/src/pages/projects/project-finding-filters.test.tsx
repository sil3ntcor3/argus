import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectFindingFilters } from './project-finding-filters';

const mock = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ hasPermission: () => mock.allowed }),
}));
vi.mock('@/pages/vulnerabilities/vulnerability-filter-fields', () => ({
  VULNERABILITY_FILTER_FIELDS: [
    {
      key: 'target',
      useSuggestions: () => {
        useState('query-hook');
        return {};
      },
    },
  ],
}));
vi.mock('@/components/filter-builder/filter-toolbar', () => ({
  FilterToolbar: ({
    fields,
  }: {
    fields: { useSuggestions: () => unknown }[];
  }) => {
    const [open, setOpen] = useState(false);
    fields[0].useSuggestions();
    return (
      <button onClick={() => setOpen(true)}>
        {open ? 'Builder open' : 'Open builder'}
      </button>
    );
  },
}));
describe('Project finding filter capabilities', () => {
  beforeEach(() => {
    mock.allowed = true;
  });
  it('remounts hook-bearing suggestions when live target/tool access changes', () => {
    const props = { value: { page: 1 }, onChange: vi.fn() };
    const view = render(<ProjectFindingFilters {...props} />);
    fireEvent.click(screen.getByText('Open builder'));
    expect(screen.getByText('Builder open')).toBeVisible();
    mock.allowed = false;
    view.rerender(<ProjectFindingFilters {...props} />);
    expect(screen.getByText('Open builder')).toBeVisible();
    fireEvent.click(screen.getByText('Open builder'));
    mock.allowed = true;
    view.rerender(<ProjectFindingFilters {...props} />);
    expect(screen.getByText('Open builder')).toBeVisible();
  });
});
