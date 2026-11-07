import type { ProjectOverviewActivityDto } from '@/services/apis/gen/queries';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOverviewActivity } from './project-overview-activity';

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

const runId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const events: ProjectOverviewActivityDto[] = [
  {
    kind: 'run',
    ref: runId,
    at: '2026-11-07T10:00:00Z',
    workflowName: 'Perimeter scan',
    jobRunType: 'scheduled',
    runStatus: 'cancelled',
    scopeSize: 4,
    newVulnerabilities: 2,
    recurringVulnerabilities: 3,
  },
  {
    kind: 'audit',
    ref: 'project.updated',
    at: '2026-11-06T10:00:00Z',
    change: 'assets.added',
    added: 4,
    actorName: 'API key',
  },
  {
    kind: 'dismissed',
    ref: 'dismissed',
    at: '2026-11-05T10:00:00Z',
    count: 2,
    reason: 'false_positive',
    actorName: 'Analyst',
  },
];

describe('ProjectOverviewActivity', () => {
  it('shows run, project change, and dismissal summaries in response order', () => {
    render(<ProjectOverviewActivity events={events} canOpenRuns />);
    const [run, audit, dismissed] = screen.getAllByRole('listitem');
    expect(
      within(run).getByRole('link', { name: /Perimeter scan, Scheduled, / }),
    ).toHaveAttribute('href', `/jobs/runs/${runId}`);
    expect(run).toHaveTextContent('Cancelled');
    expect(run).toHaveTextContent(
      'Scheduled · 4 in scope · 2 new · 3 recurring',
    );
    expect(audit).toHaveTextContent('Assets added');
    expect(audit).toHaveTextContent('4 added · API key');
    expect(dismissed).toHaveTextContent('2 findings dismissed');
    expect(dismissed).toHaveTextContent('False positive · Analyst');
  });

  it('keeps project-visible run summaries and hides links without job read access', () => {
    render(<ProjectOverviewActivity events={events} canOpenRuns={false} />);
    expect(screen.getByText('Perimeter scan')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('uses a generic title for an unknown project change reference', () => {
    render(
      <ProjectOverviewActivity
        events={[{ ...events[1], ref: 'legacy-event-ref', change: undefined }]}
        canOpenRuns
      />,
    );
    expect(screen.getByText('Project updated')).toBeVisible();
    expect(screen.queryByText('legacy-event-ref')).not.toBeInTheDocument();
  });

  it('explains an empty feed', () => {
    render(<ProjectOverviewActivity events={[]} canOpenRuns />);
    expect(screen.getByText('No project activity yet.')).toBeVisible();
  });
});
