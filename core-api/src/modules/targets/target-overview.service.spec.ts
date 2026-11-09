import { randomUUID } from 'node:crypto';
import { CronSchedule } from '@/common/enums/enum';
import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { TargetOverviewService } from './target-overview.service';

describe('TargetOverviewService', () => {
  const id = randomUUID();
  const workspaceId = randomUUID();
  const access = { jobs: false, findings: false };
  const query = jest.fn();
  const service = new TargetOverviewService({ query } as unknown as DataSource);

  beforeEach(() => {
    query.mockReset();
  });

  it('returns numeric counts from one parameterized query', async () => {
    const counts = {
      totalAssets: 0,
      newAssets: 0,
      totalServices: 0,
      newServices: 0,
      openPorts: 0,
      exposure: { ports: [], technologies: [], statusCodes: [] },
    };
    query.mockResolvedValueOnce([
      {
        ...counts,
        scanSchedule: CronSchedule.DAILY,
        stale: false,
        daysSinceDiscovery: 1,
        expiringTlsServices: 0,
        failedRunId: null,
        findings: null,
      },
    ]);
    await expect(service.getOverview(id, workspaceId, access)).resolves.toEqual({
      ...counts,
      openVulnerabilities: null,
      newVulnerabilities: null,
      insights: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE t.id = $1 AND t."workspaceId" = $2'),
      [id, workspaceId, false, false],
    );
  });

  it('throws 404 when no target matches the selected workspace', async () => {
    query.mockResolvedValueOnce([]);
    await expect(service.getOverview(id, workspaceId, access)).rejects.toThrow(
      NotFoundException,
    );
  });
});
