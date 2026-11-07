import type { ProjectOverviewWeekDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectFindingTrends } from './project-finding-trends';

const week = (date: string, counts: Partial<ProjectOverviewWeekDto> = {}) => ({
  week: date,
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
  ...counts,
});

describe('ProjectFindingTrends', () => {
  it('reports when the selected project has no new findings in the period', () => {
    render(
      <ProjectFindingTrends weeks={[week('2026-10-26'), week('2026-11-02')]} />,
    );
    expect(
      screen.getByText('No new findings in these eight weeks.'),
    ).toBeVisible();
  });

  it('shows each severity and the total alongside the UTC week start', () => {
    render(
      <ProjectFindingTrends
        weeks={[
          week('2026-10-26', { high: 4 }),
          week('2026-11-02', { critical: 2, medium: 3, low: 1 }),
        ]}
      />,
    );
    expect(
      screen.queryByText('No new findings in these eight weeks.'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('View weekly counts'));
    const table = screen.getByRole('table', {
      name: 'New findings by week and severity',
    });
    const row = within(table).getByRole('row', { name: /Nov 2, 2026/ });
    expect(within(row).getByRole('rowheader')).toHaveTextContent('Nov 2, 2026');
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['2', '0', '3', '1', '0', '6']);
  });
});
