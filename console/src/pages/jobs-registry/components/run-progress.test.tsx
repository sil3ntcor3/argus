import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunProgress } from './run-progress';

describe('RunProgress', () => {
  it('does not show a progress percentage without steps or tools', () => {
    render(<RunProgress activeJobsCount={2} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
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
