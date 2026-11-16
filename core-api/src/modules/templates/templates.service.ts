import { ARTIFACT_BUCKET } from '@/common/constants/artifact-storage';
import type { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import type { GetManyBaseResponseDto } from '@/common/dtos/get-many-base.dto';
import { AuditActorType, AuditOutcome, JobRunType } from '@/common/enums/enum';
import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import { AssetGroupAsset } from '@/modules/asset-group/entities/asset-groups-assets.entity';
import { Asset } from '@/modules/assets/entities/assets.entity';
import { ArtifactReadService } from '@/modules/artifacts/artifact-read.service';
import type { ArtifactListItemDto } from '@/modules/artifacts/dto/artifact-list.dto';
import { ArtifactFolder } from '@/modules/artifacts/entities/artifact-folder.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { EVENT_CATALOG } from '@/modules/event-bridge/contracts/event-catalog';
import type { EventEnvelopeData } from '@/modules/event-bridge/contracts/event-envelope';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { JobsRegistryService } from '@/modules/jobs-registry/jobs-registry.service';
import { StorageService } from '@/modules/storage/storage.service';
import { Target } from '@/modules/targets/entities/target.entity';
import { ToolsService } from '@/modules/tools/tools.service';
import { WorkspaceTool } from '@/modules/tools/entities/workspace_tools.entity';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { getManyResponse } from '@/utils/getManyResponse';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { CreateTemplateDto, GetTemplatesQueryDto, RenameTemplateDto, RunTemplatesDto, SaveTemplateContentDto, TemplateContentDto } from './dto/templates.dto';
import { TemplateArtifactService, TEMPLATES_FOLDER_NAME } from './template-artifact.service';
import { validateTemplate } from './template-validation';
import { readTemplateContent } from './read-template-content';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly writer: TemplateArtifactService,
    private readonly artifacts: ArtifactReadService,
    private readonly storage: StorageService,
    private readonly tools: ToolsService,
    private readonly jobs: JobsRegistryService,
    private readonly events: EventBridgeService,
  ) {}

  private templates(workspaceId: string) {
    return this.dataSource.getRepository(WorkspaceArtifact).createQueryBuilder('artifact')
      .innerJoin(ArtifactFolder, 'folder', 'folder.id = artifact.parentFolderId AND folder.workspaceId = artifact.workspaceId')
      .leftJoin('artifact.createdBy', 'creator').addSelect(['creator.id', 'creator.name', 'creator.image'])
      .where('artifact.workspaceId = :workspaceId', { workspaceId })
      .andWhere('folder.name = :folderName AND folder.parentFolderId IS NULL AND folder.createdByUserId IS NULL', { folderName: TEMPLATES_FOLDER_NAME })
      .andWhere("artifact.source = 'template' AND artifact.status = 'ready'");
  }

  private readable(userId: string): [string, { userId: string }] {
    return [`(artifact."createdByUserId" = :userId OR artifact."shareType" = 'public' OR
      (artifact."shareType" = 'shared' AND EXISTS (
        SELECT 1 FROM artifact_shares share JOIN workspace_members member
          ON member."workspaceId" = artifact."workspaceId" AND member."userId" = share."userId"
        WHERE share."artifactId" = artifact.id AND share."userId" = :userId
      )))`, { userId }];
  }

  async getMany(workspaceId: string, userId: string, query: GetTemplatesQueryDto): Promise<GetManyBaseResponseDto<ArtifactListItemDto>> {
    const builder = this.templates(workspaceId);
    if (query.scope === 'shared') builder.andWhere('artifact.createdByUserId IS DISTINCT FROM :userId', { userId }).andWhere(...this.readable(userId));
    else builder.andWhere('artifact.createdByUserId = :userId', { userId });
    if (query.search?.trim()) {
      const literal = query.search.trim().replace(/[\\%_]/g, '\\$&');
      builder.andWhere('artifact.name ILIKE :search', { search: `%${literal}%` });
    }
    const sort = ['createdAt', 'updatedAt', 'name'].includes(query.sortBy) ? query.sortBy : 'createdAt';
    const [rows, total] = await builder.orderBy(`artifact.${sort}`, query.sortOrder).addOrderBy('artifact.id', query.sortOrder)
      .skip((query.page - 1) * query.limit).take(query.limit).getManyAndCount();
    return getManyResponse({ query, data: rows.map(row => this.artifacts.toMetadata(row, userId)), total });
  }

  private async findTemplates(workspaceId: string, userId: string, ids: string[]): Promise<WorkspaceArtifact[]> {
    const rows = await this.templates(workspaceId).andWhere('artifact.id IN (:...ids)', { ids }).andWhere(...this.readable(userId)).getMany();
    const byId = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => {
      const row = byId.get(id);
      if (!row) throw new NotFoundException('Template not found');
      return row;
    });
  }

  async getContent(workspaceId: string, userId: string, id: string): Promise<TemplateContentDto> {
    const [file] = await this.findTemplates(workspaceId, userId, [id]);
    const content = await readTemplateContent(this.storage, ARTIFACT_BUCKET, file.objectKey);
    return { artifact: this.artifacts.toMetadata(file, userId), content };
  }

  async create(workspaceId: string, userId: string, dto: CreateTemplateDto): Promise<ArtifactListItemDto> {
    const file = await this.writer.create({ workspaceId, userId, name: dto.name, content: dto.content });
    return this.artifacts.getById(workspaceId, userId, file.id, []);
  }

  async saveContent(workspaceId: string, userId: string, id: string, dto: SaveTemplateContentDto): Promise<ArtifactListItemDto> {
    await this.writer.replaceContent({ workspaceId, userId, artifactId: id, content: dto.content });
    return this.artifacts.getById(workspaceId, userId, id, []);
  }

  async rename(workspaceId: string, userId: string, id: string, dto: RenameTemplateDto): Promise<ArtifactListItemDto> {
    const name = dto.name.trim();
    validateTemplate(name);
    await this.dataSource.transaction(async manager => {
      const workspace = await manager.findOne(Workspace, { where: { id: workspaceId }, select: { id: true }, lock: { mode: 'for_key_share' } });
      if (!workspace) throw new NotFoundException('Template not found');
      const repo = manager.getRepository(WorkspaceArtifact);
      const file = await repo.createQueryBuilder('artifact').setLock('pessimistic_write', undefined, ['artifact'])
        .innerJoin(ArtifactFolder, 'folder', 'folder.id = artifact.parentFolderId AND folder.workspaceId = artifact.workspaceId')
        .where('artifact.id = :id AND artifact.workspaceId = :workspaceId AND artifact.createdByUserId = :userId', { id, workspaceId, userId })
        .andWhere("artifact.source = 'template' AND artifact.status = 'ready'")
        .andWhere('folder.name = :name AND folder.parentFolderId IS NULL AND folder.createdByUserId IS NULL', { name: TEMPLATES_FOLDER_NAME })
        .getOne();
      if (!file) throw new NotFoundException('Template not found');
      file.name = name;
      await repo.save(file);
    });
    await this.events.publishSafely(EVENT_CATALOG.artifact.updated, {
      workspaceId, actor: { type: AuditActorType.User, id: userId }, outcome: AuditOutcome.Success,
      resourceType: 'artifact', resourceId: id, metadata: { fields: ['name'] },
    } satisfies EventEnvelopeData, { subject: `workspace:${workspaceId}/artifact:${id}` });
    return this.artifacts.getById(workspaceId, userId, id, []);
  }

  async run(workspaceId: string, userId: string, dto: RunTemplatesDto): Promise<DefaultMessageResponseDto> {
    if ([dto.targetIds, dto.assetIds, dto.projectIds].filter(ids => ids?.length).length !== 1) throw new BadRequestException('Choose exactly one of targetIds, assetIds or projectIds');
    const templateIds = [...new Set(dto.templateIds)];
    const templates = await this.findTemplates(workspaceId, userId, templateIds);
    let assetIds = dto.assetIds?.length ? [...new Set(dto.assetIds)] : undefined;
    const targetIds = dto.targetIds?.length ? [...new Set(dto.targetIds)] : undefined;
    if (targetIds) {
      const count = await this.dataSource.getRepository(Target).createQueryBuilder('target')
        .where('target.id IN (:...ids) AND target.workspaceId = :workspaceId', { ids: targetIds, workspaceId }).getCount();
      if (count !== targetIds.length) throw new NotFoundException('Target not found');
    }
    if (assetIds) {
      const count = await this.dataSource.getRepository(Asset).createQueryBuilder('asset').innerJoin('asset.target', 'target')
        .where('asset.id IN (:...ids) AND target.workspaceId = :workspaceId', { ids: assetIds, workspaceId }).getCount();
      if (count !== assetIds.length) throw new NotFoundException('Asset not found');
    }
    if (dto.projectIds?.length) {
      const ids = [...new Set(dto.projectIds)];
      const count = await this.dataSource.getRepository(AssetGroup).createQueryBuilder('project')
        .where('project.id IN (:...ids) AND project.workspaceId = :workspaceId AND project.archivedAt IS NULL', { ids, workspaceId }).getCount();
      if (count !== ids.length) throw new NotFoundException('Project not found');
      const members = await this.dataSource.getRepository(AssetGroupAsset).createQueryBuilder('membership')
        .innerJoin('membership.assetGroup', 'project').innerJoin('membership.asset', 'asset').innerJoin('asset.target', 'target')
        .where('project.id IN (:...ids) AND project.workspaceId = :workspaceId AND target.workspaceId = :workspaceId', { ids, workspaceId })
        .andWhere('asset.isEnabled = true').select('asset.id', 'id').getRawMany<{ id: string }>();
      assetIds = [...new Set(members.map(row => row.id))];
      if (!assetIds.length) throw new BadRequestException('The selected projects have no enabled assets');
    }
    const [nuclei] = await this.tools.getToolByNames({ names: ['nuclei'] });
    const installed = nuclei && await this.dataSource.getRepository(WorkspaceTool).existsBy({ workspace: { id: workspaceId }, tool: { id: nuclei.id }, isEnabled: true });
    if (!installed) throw new NotFoundException('Nuclei is not available in this workspace');
    const jobs = await this.jobs.createNewJob({
      tool: nuclei, workspaceId, targetIds, assetIds, priority: nuclei.priority,
      jobName: templates.length === 1 ? templates[0].name : `${templates.length} custom templates`, jobRunType: JobRunType.MANUAL,
      customTemplateIds: templateIds, customTemplateActorId: userId,
    });
    if (!jobs.length) throw new BadRequestException('Nothing to scan: choose enabled assets supported by Nuclei');
    return { message: `Running ${templates.length} template(s) on ${jobs.length} asset(s)` };
  }
}
