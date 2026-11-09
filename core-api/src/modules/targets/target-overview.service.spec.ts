import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { TargetOverviewService } from './target-overview.service';

describe('TargetOverviewService', () => {
  const id = randomUUID();
  const workspaceId = randomUUID();
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
    };
    query.mockResolvedValueOnce([counts]);
    await expect(service.getOverview(id, workspaceId)).resolves.toEqual(counts);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE t.id = $1 AND t."workspaceId" = $2'),
      [id, workspaceId],
    );
  });

  it('throws 404 when no target matches the selected workspace', async () => {
    query.mockResolvedValueOnce([]);
    await expect(service.getOverview(id, workspaceId)).rejects.toThrow(
      NotFoundException,
    );
  });
});
