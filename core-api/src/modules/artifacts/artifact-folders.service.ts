import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { ArtifactFolderDetailDto, ArtifactFolderDto } from './dto/artifact-folder.dto';
import { ArtifactFolder } from './entities/artifact-folder.entity';

const MAX_FOLDER_DEPTH = 100;

@Injectable()
export class ArtifactFoldersService {
  constructor(
    @InjectRepository(ArtifactFolder)
    private readonly folders: Repository<ArtifactFolder>,
  ) {}

  async getMany(workspaceId: string, userId: string, parentFolderId?: string): Promise<ArtifactFolderDto[]> {
    if (parentFolderId) {
      const parent = await this.getById(workspaceId, userId, parentFolderId);
      if (parent.path.length > MAX_FOLDER_DEPTH) return [];
    }

    const folders = await this.folders.find({
      where: { workspaceId, createdByUserId: userId, parentFolderId: parentFolderId ?? IsNull() },
      select: { id: true, name: true, parentFolderId: true, createdAt: true, updatedAt: true },
      order: { name: 'ASC', id: 'ASC' },
    });
    return folders.map(folder => this.toDto(folder));
  }

  async getById(workspaceId: string, userId: string, id: string): Promise<ArtifactFolderDetailDto> {
    // Scope every step so even an inconsistent parent chain cannot expose another owner's names.
    const ancestors = await this.folders.query<ArtifactFolderDto[]>(
      `WITH RECURSIVE ancestors AS (
        SELECT id, name, "parentFolderId", "createdAt", "updatedAt", 0 AS depth
        FROM artifact_folders
        WHERE id = $1 AND "workspaceId" = $2 AND "createdByUserId" = $3
        UNION ALL
        SELECT folder.id, folder.name, folder."parentFolderId", folder."createdAt", folder."updatedAt", ancestors.depth + 1
        FROM artifact_folders folder JOIN ancestors ON folder.id = ancestors."parentFolderId"
        WHERE folder."workspaceId" = $2 AND folder."createdByUserId" = $3 AND ancestors.depth < $4
      )
      SELECT id, name, "parentFolderId", "createdAt", "updatedAt" FROM ancestors ORDER BY depth`,
      [id, workspaceId, userId, MAX_FOLDER_DEPTH],
    );
    const [folder] = ancestors;
    if (!folder || ancestors.at(-1)?.parentFolderId !== null) {
      throw new NotFoundException('Folder not found');
    }
    return {
      ...this.toDto(folder),
      path: ancestors.reverse().map(({ id: folderId, name }) => ({ id: folderId, name })),
    };
  }

  private toDto({ id, name, parentFolderId, createdAt, updatedAt }: ArtifactFolderDto): ArtifactFolderDto {
    return { id, name, parentFolderId, createdAt, updatedAt };
  }
}
