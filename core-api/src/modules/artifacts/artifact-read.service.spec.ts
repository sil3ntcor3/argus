import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { ArtifactReadService } from './artifact-read.service';
import { ArtifactListQueryDto, ArtifactListScope } from './dto/artifact-list.dto';
import type { WorkspaceArtifact } from './entities/workspace-artifact.entity';

describe('ArtifactReadService', () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const builder = {
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
    getOne: jest.fn(),
  };
  const createQueryBuilder = jest.fn(() => builder);
  const service = new ArtifactReadService({ createQueryBuilder } as unknown as Repository<WorkspaceArtifact>);

  beforeEach(() => jest.clearAllMocks());

  it('rejects all scope before querying without manage permission', async () => {
    const query = Object.assign(new ArtifactListQueryDto(), { scope: ArtifactListScope.ALL });
    await expect(service.getMany(workspaceId, userId, query, ['artifact.read'])).rejects.toThrow(ForbiddenException);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns not found when the ready, workspace-scoped lookup yields no owned file', async () => {
    const id = randomUUID();
    builder.getOne.mockResolvedValueOnce(null);
    await expect(service.getById(workspaceId, userId, id, ['artifact.read'])).rejects.toThrow(NotFoundException);
    expect(builder.where).toHaveBeenCalledWith('artifact.workspaceId = :workspaceId', { workspaceId });
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.status = :status', { status: 'ready' });
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.id = :id', { id });
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.createdByUserId = :userId', { userId });
  });

  it('maps a legacy row without a creator and preserves the largest supported byte count', async () => {
    const id = randomUUID();
    const date = new Date();
    builder.getManyAndCount.mockResolvedValueOnce([[
      { id, name: 'archive', mimeType: 'application/octet-stream', source: 'upload',
        createdBy: null, createdByUserId: null, sizeBytes: String(Number.MAX_SAFE_INTEGER),
        objectKey: 'private', metadata: { internal: true }, createdAt: date, updatedAt: date },
    ], 1]);
    const query = Object.assign(new ArtifactListQueryDto(), { scope: ArtifactListScope.ALL });
    const result = await service.getMany(workspaceId, userId, query, ['*']);
    expect(result.data).toEqual([{
      id, name: 'archive', mimeType: 'application/octet-stream', source: 'upload',
      createdBy: null, isOwner: false, sizeBytes: Number.MAX_SAFE_INTEGER, createdAt: date, updatedAt: date,
    }]);
  });
});
