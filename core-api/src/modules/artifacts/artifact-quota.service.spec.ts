import type { EntityManager } from 'typeorm';
import { ArtifactQuotaService } from './artifact-quota.service';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

describe('Artifact quota overrides', () => {
  const quota = new ArtifactQuotaService();
  const builder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const manager = {
    queryRunner: { isTransactionActive: true },
    createQueryBuilder: jest.fn(() => builder),
  };

  beforeEach(() => jest.clearAllMocks());

  it.each([null, 0, Number.MAX_SAFE_INTEGER])('upserts only the override for %s', async value => {
    await quota.setQuota(manager as unknown as EntityManager, 'workspace', value);
    expect(builder.into).toHaveBeenCalledWith(WorkspaceStorageUsage);
    expect(builder.values).toHaveBeenCalledWith({ workspaceId: 'workspace', quotaBytes: value === null ? null : String(value) });
    expect(builder.orUpdate).toHaveBeenCalledWith(['quotaBytes', 'updatedAt'], ['workspaceId']);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])('rejects invalid override %s before writing', async value => {
    await expect(quota.setQuota(manager as unknown as EntityManager, 'workspace', value as number))
      .rejects.toBeInstanceOf(RangeError);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('requires an active caller transaction', async () => {
    await expect(quota.setQuota({} as EntityManager, 'workspace', null)).rejects.toThrow('transaction');
  });
});
