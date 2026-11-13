import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';

/** Opt into private metadata only for a tenant-scoped project operation. */
export async function findProjectOrFail(repo: Repository<AssetGroup>, id: string, workspaceId: string, options: { writable?: boolean } = {}) {
  const project = await repo.createQueryBuilder('project')
    .addSelect(['project.instruction', 'project.description', 'project.archivedAt', 'project.autoAddAssets'])
    .where('project.id = :id AND project."workspaceId" = :workspaceId', { id, workspaceId }).getOne();
  if (!project) throw new NotFoundException('Project not found');
  if (options.writable && project.archivedAt) throw new BadRequestException('Project is archived');
  return project;
}
