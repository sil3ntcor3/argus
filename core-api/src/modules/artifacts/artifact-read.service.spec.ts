import { ARTIFACT_BUCKET, workspaceArtifactKey } from '@/common/constants/artifact-storage';
import type { StorageService } from '@/modules/storage/storage.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import type { ArtifactFoldersService } from './artifact-folders.service';
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
  const getPresignedDownloadUrl = jest.fn();
  const getFolder = jest.fn();
  const service = new ArtifactReadService(
    { createQueryBuilder } as unknown as Repository<WorkspaceArtifact>,
    { getPresignedDownloadUrl } as unknown as StorageService,
    { getById: getFolder } as unknown as ArtifactFoldersService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    builder.getManyAndCount.mockResolvedValue([[], 0]);
  });

  it('rejects all scope before querying without manage permission', async () => {
    const query = Object.assign(new ArtifactListQueryDto(), { scope: ArtifactListScope.ALL });
    await expect(service.getMany(workspaceId, userId, query, ['artifact.read'])).rejects.toThrow(ForbiddenException);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('filters owned root files before pagination without looking up a folder', async () => {
    const query = Object.assign(new ArtifactListQueryDto(), { parentFolderId: 'root' });
    await service.getMany(workspaceId, userId, query, ['artifact.read']);
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.parentFolderId IS NULL');
    expect(getFolder).not.toHaveBeenCalled();
  });

  it('validates folder ownership before returning files', async () => {
    const parentFolderId = randomUUID();
    getFolder.mockRejectedValueOnce(new NotFoundException());
    const query = Object.assign(new ArtifactListQueryDto(), { parentFolderId });
    await expect(service.getMany(workspaceId, userId, query, ['artifact.read'])).rejects.toThrow(NotFoundException);
    expect(getFolder).toHaveBeenCalledWith(workspaceId, userId, parentFolderId);
    expect(builder.getManyAndCount).not.toHaveBeenCalled();
  });

  it('rejects a folder filter in the all scope even for a manager', async () => {
    const query = Object.assign(new ArtifactListQueryDto(), { scope: ArtifactListScope.ALL, parentFolderId: 'root' });
    await expect(service.getMany(workspaceId, userId, query, ['artifact.manage'])).rejects.toThrow(BadRequestException);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns not found when the ready, workspace-scoped lookup yields no readable file', async () => {
    const id = randomUUID();
    builder.getOne.mockResolvedValueOnce(null);
    await expect(service.getById(workspaceId, userId, id, ['artifact.read'])).rejects.toThrow(NotFoundException);
    expect(builder.where).toHaveBeenCalledWith('artifact.workspaceId = :workspaceId', { workspaceId });
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.status = :status', { status: 'ready' });
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.id = :id', { id });
    expect(builder.andWhere).toHaveBeenCalledWith(expect.stringContaining('recipient_share."userId" = :userId'), { userId });
  });

  it('does not sign a URL when the readable ready file is absent', async () => {
    const id = randomUUID();
    builder.getOne.mockResolvedValueOnce(null);
    await expect(service.getDownloadUrl(workspaceId, userId, id)).rejects.toThrow(NotFoundException);
    expect(builder.where).toHaveBeenCalledWith('artifact.workspaceId = :workspaceId', { workspaceId });
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.status = :status', { status: 'ready' });
    expect(builder.andWhere).toHaveBeenCalledWith('artifact.id = :id', { id });
    expect(builder.andWhere).toHaveBeenCalledWith(expect.stringContaining('JOIN workspace_members'), { userId });
    expect(builder.select).toHaveBeenCalledWith(['artifact.id', 'artifact.name', 'artifact.objectKey']);
    expect(getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it.each(['report.html', ''])('signs the canonical object for download with display name %j', async name => {
    const id = randomUUID();
    const key = workspaceArtifactKey(workspaceId, id);
    builder.getOne.mockResolvedValueOnce({ id, name, objectKey: key });
    const signed = { url: '/api/storage/artifacts/signed-fixture', expiresIn: 300 };
    getPresignedDownloadUrl.mockResolvedValueOnce(signed);
    await expect(service.getDownloadUrl(workspaceId, userId, id)).resolves.toEqual(signed);
    expect(getPresignedDownloadUrl).toHaveBeenCalledWith({
      bucket: ARTIFACT_BUCKET, key, fileName: name || 'file',
      contentType: 'application/octet-stream', expiresIn: 300,
    });
  });

  it('maps a legacy row without a creator and preserves the largest supported byte count', async () => {
    const id = randomUUID();
    const date = new Date();
    builder.getManyAndCount.mockResolvedValueOnce([[
      { id, name: 'archive', mimeType: 'application/octet-stream', source: 'upload', shareType: 'private',
        createdBy: null, createdByUserId: null, sizeBytes: String(Number.MAX_SAFE_INTEGER),
        objectKey: 'private', metadata: { internal: true }, createdAt: date, updatedAt: date },
    ], 1]);
    const query = Object.assign(new ArtifactListQueryDto(), { scope: ArtifactListScope.ALL });
    const result = await service.getMany(workspaceId, userId, query, ['*']);
    expect(result.data).toEqual([{
      id, name: 'archive', mimeType: 'application/octet-stream', source: 'upload', shareType: 'private',
      createdBy: null, isOwner: false, sizeBytes: Number.MAX_SAFE_INTEGER, createdAt: date, updatedAt: date,
    }]);
  });
});
