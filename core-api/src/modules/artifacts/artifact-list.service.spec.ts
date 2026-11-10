import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { ArtifactListService } from './artifact-list.service';
import { ArtifactListQueryDto, ArtifactListScope } from './dto/artifact-list.dto';
import type { WorkspaceArtifact } from './entities/workspace-artifact.entity';

describe('ArtifactListService', () => {
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
  };
  const createQueryBuilder = jest.fn(() => builder);
  const service = new ArtifactListService({ createQueryBuilder } as unknown as Repository<WorkspaceArtifact>);

  beforeEach(() => jest.clearAllMocks());

  it('rejects all scope before querying without manage permission', async () => {
    const query = Object.assign(new ArtifactListQueryDto(), { scope: ArtifactListScope.ALL });
    await expect(service.getMany(workspaceId, userId, query, ['artifact.read'])).rejects.toThrow(ForbiddenException);
    expect(createQueryBuilder).not.toHaveBeenCalled();
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
