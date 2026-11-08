import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { TargetSummaryService } from './target-summary.service';

describe('TargetSummaryService', () => {
  const workspaceId = randomUUID();
  const counts = { total: 0, scanning: 0, scheduled: 0, stale: 0 };
  const findings = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const query = jest.fn();
  const service = new TargetSummaryService({ query } as unknown as DataSource);

  beforeEach(() => {
    query.mockReset().mockResolvedValueOnce([counts]);
  });

  it('skips the findings query for callers without vulnerability access', async () => {
    await expect(service.getSummary(workspaceId, false)).resolves.toEqual({
      ...counts,
      withCritical: null,
      openVulnerabilities: null,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([
      workspaceId,
      'pending',
      'in_progress',
      'disabled',
    ]);
  });

  it('returns numeric zeros for an empty workspace with vulnerability access', async () => {
    query.mockResolvedValueOnce([{ withCritical: 0, ...findings }]);
    await expect(service.getSummary(workspaceId, true)).resolves.toEqual({
      ...counts,
      withCritical: 0,
      openVulnerabilities: findings,
    });
    expect(query.mock.calls[1][1]).toEqual([workspaceId]);
  });
});
