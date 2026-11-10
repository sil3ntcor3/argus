import type { StorageService } from '@/modules/storage/storage.service';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { ArtifactCleanupService } from './artifact-cleanup.service';
import type { ArtifactQuotaService } from './artifact-quota.service';

describe('ArtifactCleanupService', () => {
  const location = { workspaceId: randomUUID(), artifactId: randomUUID() };
  const userId = randomUUID();
  const update = jest.fn();
  const transaction = jest.fn();
  const deleteArtifactUploadObjects = jest.fn();
  const service = new ArtifactCleanupService(
    { getRepository: () => ({ update }), transaction } as unknown as DataSource,
    { deleteArtifactUploadObjects } as unknown as StorageService,
    {} as ArtifactQuotaService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('skips storage cleanup when a concurrent change prevents the ready transition', async () => {
    update.mockResolvedValueOnce({ affected: 0 });
    await expect(service.remove(location, userId, ['artifact.write'])).rejects.toThrow(NotFoundException);
    expect(update).toHaveBeenCalledWith({
      id: location.artifactId, workspaceId: location.workspaceId, status: 'ready', createdByUserId: userId,
    }, { status: 'deleted' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('removes the known keys if the workspace cascades away after the tombstone commits', async () => {
    update.mockResolvedValueOnce({ affected: 1 });
    const manager = { query: jest.fn(), findOne: jest.fn().mockResolvedValueOnce(null) };
    transaction.mockImplementationOnce((work: (tx: EntityManager) => Promise<boolean>) =>
      work(manager as unknown as EntityManager));
    deleteArtifactUploadObjects.mockResolvedValueOnce(undefined);
    await expect(service.remove(location, userId, ['artifact.write'])).resolves.toEqual({ message: 'File deleted' });
    expect(deleteArtifactUploadObjects).toHaveBeenCalledWith(location);
  });
});
