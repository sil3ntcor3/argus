import type { ProjectFindingTimelineRunDto } from '@/services/apis/gen/queries';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectFindingTimeline } from './project-finding-timeline';

const timeline = vi.hoisted(() => vi.fn());
vi.mock(import('@/services/apis/gen/queries'), async (original) => ({
  ...(await original()),
  useProjectsControllerGetFindingTimeline: timeline,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params: { id: string };
    children: ReactNode;
  }) => <a href={to.replace('$id', params.id)}>{children}</a>,
}));

const projectId = '6b1639b1-62ea-487f-892b-1288e4cf6767';
const finding = {
  id: 'd59e5709-7834-4595-bcc6-3cc104795e5c',
  name: 'Open redirect',
  assetValue: 'argus.example.test',
};
const runs: ProjectFindingTimelineRunDto[] = [
  {
    id: 'run-1',
    workflowName: 'Discovery',
    createdAt: '2026-11-01T00:00:00Z',
    sighting: 'seen',
  },
  {
    id: 'run-2',
    workflowName: 'Verification',
    createdAt: '2026-11-02T00:00:00Z',
    sighting: 'unknown',
  },
  {
    id: 'run-3',
    workflowName: 'Rescan',
    createdAt: '2026-11-03T00:00:00Z',
    sighting: 'missed',
  },
];

function open() {
  fireEvent.click(
    screen.getByRole('button', { name: /View timeline for Open redirect/ }),
  );
  return within(screen.getByRole('dialog', { name: 'Open redirect' }));
}

describe('ProjectFindingTimeline', () => {
  beforeEach(() => {
    timeline.mockReset().mockReturnValue({ data: { runs } });
  });

  it('loads only when opened and distinguishes sightings in saved run order', () => {
    render(
      <ProjectFindingTimeline
        projectId={projectId}
        finding={finding}
        canOpenRuns
      />,
    );
    expect(timeline).not.toHaveBeenCalled();
    const sheet = open();
    expect(timeline).toHaveBeenCalledWith(
      projectId,
      finding.id,
      expect.anything(),
    );
    const rows = sheet.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(sheet.getByRole('status')).toHaveTextContent(
      '3 run sightings available',
    );
    expect(rows[0]).toHaveTextContent('Reported');
    expect(rows[1]).toHaveTextContent('Scanned, sighting not recorded');
    expect(rows[2]).toHaveTextContent('Scanned, not reported');
    expect(sheet.getByRole('link', { name: 'Discovery' })).toHaveAttribute(
      'href',
      '/jobs/runs/run-1',
    );
  });

  it('keeps the sightings readable without job detail links', () => {
    render(
      <ProjectFindingTimeline
        projectId={projectId}
        finding={finding}
        canOpenRuns={false}
      />,
    );
    const sheet = open();
    expect(sheet.getByText('Discovery')).toBeVisible();
    expect(sheet.queryByRole('link')).not.toBeInTheDocument();
  });

  it('offers a retry on a request failure', () => {
    const refetch = vi.fn();
    timeline.mockReturnValue({ isError: true, refetch });
    render(
      <ProjectFindingTimeline
        projectId={projectId}
        finding={finding}
        canOpenRuns
      />,
    );
    const sheet = open();
    expect(sheet.getByRole('status')).toHaveTextContent(
      'Unable to load the finding timeline',
    );
    fireEvent.click(sheet.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });
  it('hides cached run summaries after the project finding becomes unavailable', () => {
    timeline.mockReturnValue({
      data: { runs },
      error: { isAxiosError: true, response: { status: 404 } },
      isError: true,
    });
    render(
      <ProjectFindingTimeline
        projectId={projectId}
        finding={finding}
        canOpenRuns
      />,
    );
    const sheet = open();
    expect(sheet.getByRole('status')).toHaveTextContent(
      'Finding timeline unavailable',
    );
    expect(sheet.queryByRole('list')).not.toBeInTheDocument();
  });
});
