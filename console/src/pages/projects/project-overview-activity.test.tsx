import type { ProjectOverviewActivityDto } from '@/services/apis/gen/queries';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOverviewActivity } from './project-overview-activity';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    search,
    children,
    'aria-label': label,
  }: {
    to: string;
    params: { id: string };
    search?: { status: string };
    children: ReactNode;
    'aria-label'?: string;
  }) => (
    <a
      href={
        to.replace('$id', params.id) +
        (search ? `?${new URLSearchParams(search)}` : '')
      }
      aria-label={label}
    >
      {children}
    </a>
  ),
}));

const runId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const projectId = 'db6c95e7-8ca3-41bc-90c5-25c1da402ce6';
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
  {
    kind: 'audit',
    ref: 'project.updated',
    at: '2026-11-04T10:00:00Z',
    change: 'workflow.updated',
    workflowName: 'Perimeter scan',
  },
];

describe('ProjectOverviewActivity', () => {
  it('shows run, project change, and dismissal summaries in response order', () => {
    render(
      <ProjectOverviewActivity
        projectId={projectId}
        events={events}
        canOpenRuns
      />,
    );
    const feed = screen.getByRole('list', { name: 'Project activity entries' });
    expect(feed).toHaveAttribute('tabindex', '0');
    const [run, audit, dismissed, workflow] =
      within(feed).getAllByRole('listitem');
    expect(
      within(run).getByRole('link', { name: /Perimeter scan, Scheduled, / }),
    ).toHaveAttribute('href', `/jobs/runs/${runId}`);
    expect(run).toHaveTextContent('Cancelled');
    expect(run).toHaveTextContent(
      'Scheduled · 4 in scope · 2 new · 3 recurring',
    );
    expect(
      within(audit).getByRole('link', { name: 'Assets added' }),
    ).toHaveAttribute('href', `/projects/${projectId}/assets`);
    expect(audit).toHaveTextContent('4 added · API key');
    expect(
      within(dismissed).getByRole('link', { name: '2 findings dismissed' }),
    ).toHaveAttribute(
      'href',
      `/projects/${projectId}/findings?status=dismissed`,
    );
    expect(dismissed).toHaveTextContent('False positive · Analyst');
    expect(
      within(workflow).getByRole('link', { name: 'Workflow changed' }),
    ).toHaveAttribute('href', `/projects/${projectId}/workflows`);
  });

  it('keeps project-visible run summaries and hides links without job read access', () => {
    render(
      <ProjectOverviewActivity
        projectId={projectId}
        events={events}
        canOpenRuns={false}
      />,
    );
    const [run] = screen.getAllByRole('listitem');
    expect(within(run).getByText('Perimeter scan')).toBeVisible();
    expect(within(run).queryByRole('link')).not.toBeInTheDocument();
  });

  it('uses a generic title for an unknown project change reference', () => {
    render(
      <ProjectOverviewActivity
        projectId={projectId}
        events={[{ ...events[1], ref: 'legacy-event-ref', change: undefined }]}
        canOpenRuns
      />,
    );
    expect(screen.getByText('Project updated')).toBeVisible();
    expect(screen.queryByText('legacy-event-ref')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('explains an empty feed', () => {
    render(
      <ProjectOverviewActivity projectId={projectId} events={[]} canOpenRuns />,
    );
    expect(screen.getByText('No project activity yet.')).toBeVisible();
  });
});
