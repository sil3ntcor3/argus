import { ARTIFACT_BUCKET } from '@/common/constants/artifact-storage';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { ArtifactUploadCompletionService } from '@/modules/artifacts/artifact-upload-completion.service';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { ProjectArtifact } from './entities/project-artifact.entity';
import type { PresignProjectFileDto, ProjectFileDto } from './dto/project-files.dto';

export const PROJECT_FILE_LIMIT = 5;
export const PROJECT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Readonly<Record<string, string>> = { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv' };
export interface ProjectFileText { id: string; name: string; content: string; totalChars: number }

/** Project access authorizes shared context, while uploads retain private file ownership. */
@Injectable()
export class ProjectFilesService {
  constructor(private readonly dataSource: DataSource, private readonly reservation: ArtifactUploadReservationService,
    private readonly completion: ArtifactUploadCompletionService, private readonly storage: StorageService) {}

  /** Validate live workspace/project state, locking parent before child on writes. */
  private async project(projectId: string, workspaceId: string, executor: Pick<EntityManager, 'query'> = this.dataSource, writable = false) {
    if (writable) await executor.query('SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE', [workspaceId]);
    const [project] = await executor.query<{ id: string; archivedAt: Date | null }[]>(
      `SELECT id, "archivedAt" FROM projects WHERE id=$1 AND "workspaceId"=$2${writable ? ' FOR NO KEY UPDATE' : ''}`, [projectId, workspaceId]);
    if (!project) throw new NotFoundException('Project not found');
    if (writable && project.archivedAt) throw new BadRequestException('Project is archived');
    return project;
  }

  /** Return ready attachment metadata without storage keys or private user fields. */
  async list(projectId: string, workspaceId: string): Promise<ProjectFileDto[]> {
    await this.project(projectId, workspaceId);
    return this.linked(projectId, workspaceId);
  }

  private validateFile(name: string, size: number, mime?: string) {
    const type = TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
    if (!type || (mime !== undefined && type !== mime)) throw new BadRequestException('Only .md, .txt and .csv files can be attached');
    if (!Number.isSafeInteger(size) || size < 1) throw new BadRequestException('Invalid file size');
    if (size > PROJECT_FILE_MAX_BYTES) throw new PayloadTooLargeException('A project file can be at most 10 MiB');
    return type;
  }

  /** Sign Argus's existing immutable-publication upload flow after checking capacity. */
  async presign(projectId: string, workspaceId: string, userId: string, dto: PresignProjectFileDto) {
    await this.dataSource.transaction(manager => this.project(projectId, workspaceId, manager, true));
    const contentType = this.validateFile(dto.fileName, dto.sizeBytes);
    if ((await this.linked(projectId, workspaceId)).length >= PROJECT_FILE_LIMIT) throw new BadRequestException('A project can have at most 5 files');
    const { artifact, upload } = await this.reservation.reserveUpload({ workspaceId, createdByUserId: userId, name: dto.fileName, contentType, sizeBytes: dto.sizeBytes });
    return { artifactId: artifact.id, url: upload.url, fields: upload.fields, expiresAt: upload.expiresAt };
  }

  /** Publish owned content, then serialize attachment capacity with a fresh archive check. */
  async complete(projectId: string, workspaceId: string, userId: string, artifactId: string): Promise<ProjectFileDto[]> {
    await this.dataSource.transaction(manager => this.project(projectId, workspaceId, manager, true));
    const pending = await this.dataSource.getRepository(WorkspaceArtifact).findOne({ where: { id: artifactId, workspaceId, createdByUserId: userId, source: 'upload' } });
    if (!pending || pending.status === 'deleted') throw new NotFoundException('File not found');
    this.validateFile(pending.name, Number(pending.sizeBytes), pending.mimeType);
    await this.completion.completeUpload({ workspaceId, userId, artifactId });
    await this.dataSource.transaction(async manager => {
      await this.project(projectId, workspaceId, manager, true);
      const artifact = await manager.findOne(WorkspaceArtifact, { where: { id: artifactId, workspaceId, createdByUserId: userId, status: 'ready', source: 'upload' }, lock: { mode: 'pessimistic_read' } });
      if (!artifact) throw new NotFoundException('File not found');
      const repo = manager.getRepository(ProjectArtifact);
      if (await repo.existsBy({ projectId, artifactId })) return;
      const count = await repo.count({ where: { projectId, artifact: { status: 'ready' } } });
      if (count >= PROJECT_FILE_LIMIT) throw new BadRequestException('A project can have at most 5 files; the upload stays in Files');
      await repo.insert({ projectId, artifactId });
    });
    return this.linked(projectId, workspaceId);
  }

  /** Detach only: the quota charge, content and owner sharing choices remain. */
  async remove(projectId: string, workspaceId: string, artifactId: string): Promise<ProjectFileDto[]> {
    await this.dataSource.transaction(async manager => {
      await this.project(projectId, workspaceId, manager, true);
      await manager.delete(ProjectArtifact, { projectId, artifactId });
    });
    return this.linked(projectId, workspaceId);
  }

  /** Read only an attached ready artifact in the selected workspace, bounded in bytes. */
  async readText(projectId: string, workspaceId: string, artifactId: string): Promise<ProjectFileText> {
    await this.project(projectId, workspaceId);
    const link = await this.dataSource.getRepository(ProjectArtifact).findOne({ where: { projectId, artifactId, artifact: { workspaceId, status: 'ready' } }, relations: { artifact: true } });
    if (!link) throw new NotFoundException('File not found in this project');
    const a = link.artifact;
    this.validateFile(a.name, Number(a.sizeBytes), a.mimeType);
    const { file } = await this.storage.getFile(a.objectKey, ARTIFACT_BUCKET);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of file.getStream()) {
      const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
      if (size > PROJECT_FILE_MAX_BYTES) throw new PayloadTooLargeException('Project file exceeds read limit');
      chunks.push(bytes);
    }
    const content = Buffer.concat(chunks).toString('utf8');
    return { id: a.id, name: a.name, content, totalChars: content.length };
  }

  /** Assemble bounded prompt context; unavailable files never widen the project scope. */
  async contextFiles(projectId: string, opts: { perFile: number; total: number }, workspaceId: string): Promise<ProjectFileText[]> {
    const rows = await this.list(projectId, workspaceId); let budget = opts.total;
    const files: ProjectFileText[] = [];
    for (const row of rows) {
      const file = await this.readText(projectId, workspaceId, row.id).catch(() => null);
      if (!file) continue;
      const content = file.content.slice(0, Math.min(opts.perFile, budget)); budget -= content.length;
      files.push({ id: file.id, name: file.name, content, totalChars: file.totalChars });
    }
    return files;
  }

  private async linked(projectId: string, workspaceId: string): Promise<ProjectFileDto[]> {
    const rows = await this.dataSource.query<(Omit<ProjectFileDto, 'sizeBytes'> & { sizeBytes: string })[]>(
      `SELECT a.id,a.name,a."mimeType",a."sizeBytes",u.name AS "createdByName",pa."createdAt" AS "attachedAt"
       FROM project_artifacts pa JOIN projects p ON p.id=pa."projectId" AND p."workspaceId"=$2
       JOIN artifacts a ON a.id=pa."artifactId" AND a."workspaceId"=$2 AND a.status='ready'
       LEFT JOIN users u ON u.id=a."createdByUserId" WHERE pa."projectId"=$1 ORDER BY pa."createdAt",pa.id LIMIT 5`, [projectId, workspaceId]);
    return rows.map(row => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }
}
