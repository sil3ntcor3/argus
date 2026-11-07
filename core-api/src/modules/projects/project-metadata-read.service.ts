import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssetGroupService } from '../asset-group/asset-group.service';
import { GetAllAssetGroupsQueryDto } from '../asset-group/dto/get-all-asset-groups-dto.dto';
import { ProjectViewDto } from './dto/project-view.dto';

interface ProjectMetadata {
  id: string;
  description: string | null;
  autoAddAssets: boolean;
}

/** Canonical reads opt into project provenance without changing legacy callers. */
@Injectable()
export class ProjectMetadataReadService {
  constructor(
    private readonly groups: AssetGroupService,
    private readonly dataSource: DataSource,
  ) {}

  private async metadata(
    ids: string[],
    workspaceId: string,
  ): Promise<Map<string, ProjectMetadata>> {
    if (ids.length === 0) return new Map<string, ProjectMetadata>();
    const rows = await this.dataSource.query<ProjectMetadata[]>(
      `SELECT id, description, "autoAddAssets" FROM projects
       WHERE "workspaceId" = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, ids],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  private view(project: object, metadata: ProjectMetadata): ProjectViewDto {
    const fields: Record<string, unknown> = {};
    Object.assign(fields, project);
    for (const key of ['description', 'autoAddAssets', 'archivedAt'])
      delete fields[key];
    return Object.assign(new ProjectViewDto(), fields, {
      description: metadata.description,
      autoAddAssets: metadata.autoAddAssets,
    });
  }

  async getMany(query: GetAllAssetGroupsQueryDto, workspaceId: string) {
    const result = await this.groups.getManyAssetGroups(query, workspaceId, true);
    const metadata = await this.metadata(
      result.data.map((project) => project.id),
      workspaceId,
    );
    return {
      ...result,
      data: result.data.flatMap((project) => {
        const saved = metadata.get(project.id);
        // A concurrent deletion must not fail the whole page or invent metadata.
        return saved ? [this.view(project, saved)] : [];
      }),
    };
  }

  async getById(id: string, workspaceId: string): Promise<ProjectViewDto> {
    const project = await this.groups.getAssetGroupById(id, workspaceId, true);
    const saved = (await this.metadata([project.id], workspaceId)).get(project.id);
    if (!saved) throw new NotFoundException('Project not found');
    return this.view(project, saved);
  }
}
