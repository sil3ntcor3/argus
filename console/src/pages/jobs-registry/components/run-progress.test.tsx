import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunProgress } from './run-progress';

describe('RunProgress', () => {
  it('does not show a progress percentage without steps or tools', () => {
    render(<RunProgress activeJobsCount={2} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows estimates with units and clears them when a run settles', () => {
    const tools = [
      { id: '1', name: 'First', logoUrl: '', status: 'completed' as const },
      { id: '2', name: 'Second', logoUrl: '', status: 'in_progress' as const },
    ];
    const { rerender } = render(
      <RunProgress tools={tools} activeJobsCount={1} etaSeconds={45} />,
    );
    expect(screen.getByText('About 45 sec left')).toBeVisible();

    rerender(
      <RunProgress tools={tools} activeJobsCount={1} etaSeconds={120} />,
    );
    expect(screen.getByText('About 2 min left')).toBeVisible();

    rerender(
      <RunProgress tools={tools} activeJobsCount={1} etaSeconds={3660} />,
    );
    expect(screen.getByText('About 1 hr 1 min left')).toBeVisible();

    rerender(<RunProgress tools={tools} activeJobsCount={1} etaSeconds={0} />);
    expect(screen.getByText('Less than 1 sec left')).toBeVisible();

    rerender(
      <RunProgress tools={tools} activeJobsCount={1} etaSeconds={null} />,
    );
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();

    rerender(<RunProgress tools={tools} activeJobsCount={0} etaSeconds={45} />);
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });

  it('uses settled tools for older run details without workflow steps', () => {
    render(
      <RunProgress
        activeJobsCount={0}
        tools={[
          { id: '1', name: 'Completed', logoUrl: '', status: 'completed' },
          { id: '2', name: 'Cancelled', logoUrl: '', status: 'cancelled' },
          { id: '3', name: 'Unknown', logoUrl: '' },
        ]}
      />,
    );

    const bar = screen.getByRole('progressbar', { name: 'Run progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '67');
    expect(bar).toHaveAttribute('aria-valuetext', '2 of 3 tools settled');
  });
});
