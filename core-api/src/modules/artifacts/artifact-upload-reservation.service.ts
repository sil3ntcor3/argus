import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { StorageService } from '@/modules/storage/storage.service';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ArtifactQuotaService } from './artifact-quota.service';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

interface ReserveArtifactUpload {
  workspaceId: string;
  createdByUserId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  source?: WorkspaceArtifact['source'];
  abortSignal?: AbortSignal;
}

@Injectable()
export class ArtifactUploadReservationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly quota: ArtifactQuotaService,
  ) {}

  /**
   * An authorized caller supplies the workspace and actor. The form is not
   * returned until its pending record and quota reservation both commit.
   */
  async reserveUpload({
    workspaceId, createdByUserId, name, contentType, sizeBytes, source = 'upload', abortSignal,
  }: ReserveArtifactUpload) {
    abortSignal?.throwIfAborted();
    if (!name.trim() || name.length > 255 || [...name].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })) {
      throw new BadRequestException('Invalid artifact display name');
    }

    const id = randomUUID();
    // Resolve credentials and sign before taking database locks. No object is
    // written, and failed reservations never return their form to callers.
    const upload = await this.storage.getPresignedArtifactUpload({
      workspaceId, artifactId: id, contentType, sizeBytes,
    });

    const assertLiveUpload = () => {
      abortSignal?.throwIfAborted();
      if (upload.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException('Artifact upload policy already expired');
      }
    };

    const artifact = await this.dataSource.transaction(async manager => {
      // Match workspace deletion's lock order before touching the meter or a file.
      const workspace = await manager.findOne(Workspace, {
        where: { id: workspaceId },
        select: { id: true },
        lock: { mode: 'for_key_share' },
      });
      if (!workspace) throw new NotFoundException('Workspace not found');
      assertLiveUpload();
      if (!(await this.quota.reserve(manager, workspace.id, sizeBytes))) {
        throw new ConflictException('Workspace storage quota exceeded');
      }

      const repo = manager.getRepository(WorkspaceArtifact);
      const pending = await repo.save(repo.create({
        id,
        workspaceId: workspace.id,
        createdByUserId,
        name,
        mimeType: contentType,
        sizeBytes: String(sizeBytes),
        objectKey: workspaceArtifactKey(workspace.id, id),
        source,
        status: 'pending',
        metadata: {},
        expiresAt: upload.expiresAt,
      }));
      // Quota or foreign key locks may have held the transaction past expiry.
      assertLiveUpload();
      return pending;
    });

    return { artifact, upload };
  }
}
