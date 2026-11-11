import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { StorageService } from '@/modules/storage/storage.service';
import { Injectable } from '@nestjs/common';
import { ArtifactUploadCompletionService } from './artifact-upload-completion.service';
import { ArtifactUploadReservationService } from './artifact-upload-reservation.service';

interface CreateAgentFile {
  workspaceId: string;
  userId: string;
  name: string;
  buffer: Buffer;
  contentType: string;
  abortSignal?: AbortSignal;
}

@Injectable()
export class ArtifactBufferService {
  constructor(
    private readonly reservation: ArtifactUploadReservationService,
    private readonly completion: ArtifactUploadCompletionService,
    private readonly storage: StorageService,
  ) {}

  /** The caller authorizes the workspace and actor before creating a private file. */
  async createAgentFile({ workspaceId, userId, name, buffer, contentType, abortSignal }: CreateAgentFile) {
    abortSignal?.throwIfAborted();
    const { artifact, upload } = await this.reservation.reserveUpload({
      workspaceId, createdByUserId: userId, name, contentType, sizeBytes: buffer.length, source: 'agent', abortSignal,
    });
    const deadline = AbortSignal.timeout(Math.max(0, upload.expiresAt.getTime() - Date.now()));
    const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
    // Failed or interrupted writes retain their reservation for expiry cleanup.
    await this.storage.uploadFile(
      workspaceArtifactUploadKey(workspaceId, artifact.id), buffer, ARTIFACT_BUCKET, contentType, signal,
    );
    return this.completion.completeUpload({ workspaceId, userId, artifactId: artifact.id, source: 'agent', abortSignal: signal });
  }
}
