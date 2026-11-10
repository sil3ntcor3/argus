import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IsNull, type Repository } from 'typeorm';
import { ArtifactFoldersService } from './artifact-folders.service';
import type { ArtifactFolder } from './entities/artifact-folder.entity';

describe('ArtifactFoldersService', () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const repo = { find: jest.fn(), query: jest.fn() };
  const service = new ArtifactFoldersService(repo as unknown as Repository<ArtifactFolder>);
  const date = new Date('2026-01-01T00:00:00.000Z');
  const root = { id: randomUUID(), name: 'Root', parentFolderId: null, createdAt: date, updatedAt: date };
  const child = { ...root, id: randomUUID(), name: 'Child', parentFolderId: root.id };

  beforeEach(() => jest.resetAllMocks());

  it('selects only the caller’s roots and returns public folder fields', async () => {
    repo.find.mockResolvedValueOnce([{ ...root, workspaceId, createdByUserId: userId }]);
    await expect(service.getMany(workspaceId, userId)).resolves.toEqual([root]);
    expect(repo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId, createdByUserId: userId, parentFolderId: IsNull() },
      order: { name: 'ASC', id: 'ASC' },
    }));
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('returns breadcrumb metadata from a complete owned path', async () => {
    repo.query.mockResolvedValueOnce([child, root]);
    await expect(service.getById(workspaceId, userId, child.id)).resolves.toEqual({
      ...child,
      path: [{ id: root.id, name: root.name }, { id: child.id, name: child.name }],
    });
    expect(repo.query).toHaveBeenCalledWith(expect.any(String), [child.id, workspaceId, userId, 100]);
  });

  it('does not list children when the parent chain is incomplete', async () => {
    repo.query.mockResolvedValueOnce([child]);
    await expect(service.getMany(workspaceId, userId, child.id)).rejects.toThrow(NotFoundException);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('does not list inaccessible children below the supported folder depth', async () => {
    const ancestors = [root, child];
    for (let depth = 2; depth <= 100; depth++) {
      ancestors.push({ ...child, id: randomUUID(), parentFolderId: ancestors[depth - 1].id });
    }
    ancestors.reverse();
    repo.query.mockResolvedValueOnce(ancestors);
    await expect(service.getMany(workspaceId, userId, ancestors[0].id)).resolves.toEqual([]);
    expect(repo.find).not.toHaveBeenCalled();
  });
});
