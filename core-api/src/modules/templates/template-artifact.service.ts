import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { AuditActorType, AuditOutcome } from '@/common/enums/enum';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactUploadCompletionService } from '@/modules/artifacts/artifact-upload-completion.service';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { ArtifactFolder } from '@/modules/artifacts/entities/artifact-folder.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { readTemplateRetirements, TEMPLATE_RETIREMENTS_KEY } from '@/modules/artifacts/template-retirements';
import { EVENT_CATALOG } from '@/modules/event-bridge/contracts/event-catalog';
import type { EventEnvelopeData } from '@/modules/event-bridge/contracts/event-envelope';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { StorageService } from '@/modules/storage/storage.service';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { validateTemplate } from './template-validation';

export const TEMPLATES_FOLDER_NAME = 'custom-templates';
type Actor = { workspaceId: string; userId: string; abortSignal?: AbortSignal };

/** Private writer: callers authorize the current workspace/action before entry. */
@Injectable()
export class TemplateArtifactService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly reservation: ArtifactUploadReservationService,
    private readonly completion: ArtifactUploadCompletionService,
    private readonly quota: ArtifactQuotaService,
    private readonly storage: StorageService,
    private readonly eventBridge: EventBridgeService,
  ) {}

  async create({ workspaceId, userId, name, content, abortSignal }: Actor & { name: string; content: string }): Promise<WorkspaceArtifact> {
    name = name.trim();
    validateTemplate(name, content);
    const signal = this.deadline(abortSignal);
    const folder = await this.ensureFolder(workspaceId);
    signal.throwIfAborted();
    const buffer = Buffer.from(content, 'utf8');
    const { artifact } = await this.reservation.reserveUpload({
      workspaceId, createdByUserId: userId, name, contentType: 'application/yaml',
      sizeBytes: buffer.length, source: 'template', parentFolderId: folder.id, abortSignal: signal,
      metadata: { [TEMPLATE_RETIREMENTS_KEY]: {} },
    });
    // Reuse the existing charged pending state and expiry recovery for creation.
    await this.storage.uploadFile(workspaceArtifactUploadKey(workspaceId, artifact.id), buffer, ARTIFACT_BUCKET, 'application/yaml', signal);
    const file = await this.completion.completeUpload({ workspaceId, userId, artifactId: artifact.id, source: 'template', abortSignal: signal });
    await this.audit(file, userId, 'created');
    return file;
  }

  async replaceContent({ workspaceId, userId, artifactId, content, abortSignal }: Actor & { artifactId: string; content: string }): Promise<WorkspaceArtifact> {
    validateTemplate(undefined, content);
    const signal = this.deadline(abortSignal);
    const buffer = Buffer.from(content, 'utf8');
    const file = await this.dataSource.transaction(async manager => {
      await manager.query("SET LOCAL lock_timeout = '2s'");
      const workspace = await manager.findOne(Workspace, { where: { id: workspaceId }, select: { id: true }, lock: { mode: 'for_key_share' } });
      if (!workspace) throw new NotFoundException('Template not found');
      const repo = manager.getRepository(WorkspaceArtifact);
      const artifact = await repo.findOne({
        where: { id: artifactId, workspaceId, createdByUserId: userId, source: 'template', status: 'ready' },
        lock: { mode: 'pessimistic_write' },
      });
      const folder = artifact?.parentFolderId ? await manager.findOneBy(ArtifactFolder, {
        id: artifact.parentFolderId, workspaceId, parentFolderId: IsNull(), createdByUserId: IsNull(), name: TEMPLATES_FOLDER_NAME,
      }) : null;
      if (!artifact || !folder) throw new NotFoundException('Template not found');
      const retired = readTemplateRetirements(artifact.metadata);
      if (!retired) throw new ConflictException('Template revision history needs repair');
      signal.throwIfAborted();
      const delta = buffer.length - Number(artifact.sizeBytes);
      if (delta > 0) {
        if (!(await this.quota.reserve(manager, workspaceId, delta))) throw new ConflictException('Workspace storage quota exceeded');
        if (!(await this.quota.commit(manager, workspaceId, delta))) throw new InternalServerErrorException('Template quota could not be settled');
      } else if (delta < 0 && !(await this.quota.releaseUsed(manager, workspaceId, -delta))) {
        throw new InternalServerErrorException('Template quota could not be settled');
      }
      // Keep workspace/file locks through publication. The sweeper skips this
      // workspace, even if a paused request outlives the usual cleanup grace.
      const revisionId = randomUUID();
      const previousSuffix = artifact.objectKey.split('/').at(-1)!;
      artifact.objectKey = await this.storage.publishArtifactRevision({ workspaceId, artifactId, revisionId, buffer, contentType: artifact.mimeType, abortSignal: signal });
      signal.throwIfAborted();
      retired[previousSuffix] = null;
      artifact.metadata = { ...artifact.metadata, [TEMPLATE_RETIREMENTS_KEY]: retired };
      artifact.sizeBytes = String(buffer.length);
      await repo.save(artifact);
      signal.throwIfAborted();
      return artifact;
    });
    // A failed or uncertain commit leaves private bytes for conservative cleanup.
    await this.audit(file, userId, 'updated');
    return file;
  }

  private async ensureFolder(workspaceId: string): Promise<ArtifactFolder> {
    const existing = await this.dataSource.getRepository(ArtifactFolder).findOne({
      where: { workspaceId, parentFolderId: IsNull(), createdByUserId: IsNull(), name: TEMPLATES_FOLDER_NAME },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    if (existing) return existing;
    return this.dataSource.transaction(async manager => {
      await manager.query("SET LOCAL lock_timeout = '2s'");
      const workspace = await manager.findOne(Workspace, { where: { id: workspaceId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
      if (!workspace) throw new NotFoundException('Workspace not found');
      const repo = manager.getRepository(ArtifactFolder);
      const folder = await repo.findOne({
        where: { workspaceId, parentFolderId: IsNull(), createdByUserId: IsNull(), name: TEMPLATES_FOLDER_NAME },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      return folder ?? repo.save(repo.create({ workspaceId, parentFolderId: null, createdByUserId: null, name: TEMPLATES_FOLDER_NAME }));
    });
  }

  private deadline(signal?: AbortSignal): AbortSignal {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(15_000);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }

  private async audit(file: WorkspaceArtifact, userId: string, action: 'created' | 'updated'): Promise<void> {
    await this.eventBridge.publishSafely(EVENT_CATALOG.artifact[action], {
      workspaceId: file.workspaceId, actor: { type: AuditActorType.User, id: userId },
      outcome: AuditOutcome.Success, resourceType: 'artifact', resourceId: file.id,
      metadata: { source: file.source, sizeBytes: Number(file.sizeBytes) },
    } satisfies EventEnvelopeData, { subject: `workspace:${file.workspaceId}/artifact:${file.id}` });
  }
}
