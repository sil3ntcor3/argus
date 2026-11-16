import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { ArtifactUsageService } from './artifact-usage.service';
import type { WorkspaceArtifact } from './entities/workspace-artifact.entity';
import type { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

describe('ArtifactUsageService', () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const meter = { findOneBy: jest.fn() };
  const artifacts = { createQueryBuilder: jest.fn() };
  const query = () => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  });
  let sources: ReturnType<typeof query>;
  let creators: ReturnType<typeof query>;
  let service: ArtifactUsageService;

  beforeEach(() => {
    jest.resetAllMocks();
    sources = query();
    creators = query();
    meter.findOneBy.mockResolvedValue(null);
    artifacts.createQueryBuilder.mockReturnValueOnce(sources).mockReturnValueOnce(creators);
    service = new ArtifactUsageService(
      meter as unknown as Repository<WorkspaceStorageUsage>,
      artifacts as unknown as Repository<WorkspaceArtifact>,
    );
  });

  it('returns defaults and empty breakdowns for an unmetered empty workspace', async () => {
    await expect(service.getUsage(workspaceId)).resolves.toEqual({
      quotaBytes: 1073741824, usedBytes: 0, reservedBytes: 0, maxFileBytes: 52428800,
      bySource: [], byUser: [],
    });
    expect(meter.findOneBy).toHaveBeenCalledWith({ workspaceId });
  });

  it('preserves a zero quota and maps bigint aggregates to approved user fields', async () => {
    meter.findOneBy.mockResolvedValue({ quotaBytes: '0', usedBytes: '42', reservedBytes: '19' });
    sources.getRawMany.mockResolvedValue([{ source: 'agent', bytes: '42' }]);
    creators.getRawMany.mockResolvedValue([
      { userId, userName: 'Member', userImage: null, bytes: '40', email: 'private@example.test' },
      { userId: null, userName: null, userImage: null, bytes: '2' },
    ]);
    await expect(service.getUsage(workspaceId)).resolves.toEqual({
      quotaBytes: 0, usedBytes: 42, reservedBytes: 19, maxFileBytes: 52428800,
      bySource: [{ source: 'agent', bytes: 42 }],
      byUser: [{ user: { id: userId, name: 'Member', image: null }, bytes: 40 }, { user: null, bytes: 2 }],
    });
  });

  it('scopes both ready-file queries and orders equal totals deterministically', async () => {
    await service.getUsage(workspaceId);
    for (const builder of [sources, creators]) {
      expect(builder.select).toHaveBeenCalledWith('SUM(artifact.sizeBytes)', 'bytes');
      expect(builder.where).toHaveBeenCalledWith('artifact.workspaceId = :workspaceId', { workspaceId });
      expect(builder.andWhere).toHaveBeenCalledWith('artifact.status = :status', { status: 'ready' });
      expect(builder.orderBy).toHaveBeenCalledWith('bytes', 'DESC');
    }
    expect(sources.groupBy).toHaveBeenCalledWith('artifact.source');
    expect(sources.addOrderBy).toHaveBeenCalledWith('artifact.source', 'ASC');
    expect(creators.groupBy).toHaveBeenCalledWith('creator.id');
    expect(creators.addOrderBy).toHaveBeenCalledWith('creator.id', 'ASC', 'NULLS LAST');
  });

  it('propagates a failed aggregation instead of reporting empty usage', async () => {
    sources.getRawMany.mockRejectedValue(new Error('database unavailable'));
    await expect(service.getUsage(workspaceId)).rejects.toThrow('database unavailable');
  });
});
