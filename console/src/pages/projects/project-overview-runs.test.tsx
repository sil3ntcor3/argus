import type { ProjectOverviewRunRefDto } from '@/services/apis/gen/queries';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOverviewRuns } from './project-overview-runs';

vi.mock('@tanstack/react-router', () => ({
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

const latest: ProjectOverviewRunRefDto = {
  id: '6b1639b1-62ea-487f-892b-1288e4cf6767',
  workflowName: 'Perimeter scan',
  status: 'cancelled',
  jobRunType: 'scheduled',
  createdAt: '2026-11-07T10:00:00Z',
};
const discovery: ProjectOverviewRunRefDto = {
  id: 'c2ffaf6a-90bc-433c-a9cf-449389095e28',
  workflowName: 'Initial discovery',
  status: 'completed',
  jobRunType: 'manual',
  createdAt: '2026-11-06T10:00:00Z',
};

describe('ProjectOverviewRuns', () => {
  it('keeps the latest run separate from the run that discovered findings', () => {
    render(
      <ProjectOverviewRuns
        lastRun={latest}
        discoveryRuns={[discovery]}
        canOpenRuns
      />,
    );
    const recent = within(screen.getByRole('region', { name: 'Latest run' }));
    expect(
      recent.getByRole('link', { name: /Perimeter scan, Scheduled, / }),
    ).toHaveAttribute('href', `/jobs/runs/${latest.id}`);
    expect(recent.getByText('Cancelled')).toBeVisible();
    expect(recent.getByText('Scheduled')).toBeVisible();
    const first = within(
      screen.getByRole('region', { name: 'Runs with new findings' }),
    );
    expect(
      first.getByRole('link', { name: /Initial discovery, Manual, / }),
    ).toHaveAttribute('href', `/jobs/runs/${discovery.id}`);
    expect(first.getByText('Completed')).toBeVisible();
    expect(first.getByText('Manual')).toBeVisible();
  });

  it('shows summaries without links when the user cannot read job details', () => {
    render(
      <ProjectOverviewRuns
        lastRun={latest}
        discoveryRuns={[{ ...discovery, workflowName: '   ' }]}
        canOpenRuns={false}
      />,
    );
    expect(screen.getByText(latest.workflowName)).toBeVisible();
    expect(screen.getByText('Workflow run')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows distinct empty states for run history and finding discovery', () => {
    render(
      <ProjectOverviewRuns lastRun={null} discoveryRuns={[]} canOpenRuns />,
    );
    expect(screen.getByText('No runs yet.')).toBeVisible();
    expect(
      screen.getByText('No runs with new findings in the last seven days.'),
    ).toBeVisible();
  });
});
