import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import type { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { EVENT_CATALOG } from '@/modules/event-bridge/contracts/event-catalog';
import { AuditActorType, AuditOutcome } from '@/common/enums/enum';
import type { StorageService } from '@/modules/storage/storage.service';
import type { ArtifactUploadReservationService } from './artifact-upload-reservation.service';
import type { ArtifactUploadCompletionService } from './artifact-upload-completion.service';
import { ArtifactBufferService } from './artifact-buffer.service';

describe('ArtifactBufferService', () => {
  const reserveUpload = jest.fn();
  const completeUpload = jest.fn();
  const uploadFile = jest.fn();
  const publishSafely = jest.fn();
  const service = new ArtifactBufferService(
    { reserveUpload } as unknown as ArtifactUploadReservationService,
    { completeUpload } as unknown as ArtifactUploadCompletionService,
    { uploadFile } as unknown as StorageService,
    { publishSafely } as unknown as EventBridgeService,
  );
  const input = { workspaceId: 'workspace', userId: 'actor', name: '../report.txt', buffer: Buffer.from('é'), contentType: 'text/plain' };

  beforeEach(() => {
    jest.resetAllMocks();
    reserveUpload.mockResolvedValue({ artifact: { id: 'file' }, upload: { expiresAt: new Date(Date.now() + 60_000) } });
    completeUpload.mockResolvedValue({ id: 'file', workspaceId: 'workspace', createdByUserId: 'actor', source: 'agent', sizeBytes: '2', status: 'ready' });
  });

  it('reserves actual bytes and uses a server-owned staging key before completion', async () => {
    await expect(service.createAgentFile(input)).resolves.toMatchObject({ id: 'file', status: 'ready' });
    expect(reserveUpload).toHaveBeenCalledWith({ workspaceId: 'workspace', createdByUserId: 'actor', name: input.name,
      contentType: 'text/plain', sizeBytes: 2, source: 'agent', abortSignal: undefined });
    expect(uploadFile).toHaveBeenCalledWith(workspaceArtifactUploadKey('workspace', 'file'), input.buffer,
      ARTIFACT_BUCKET, 'text/plain', expect.any(AbortSignal));
    expect(completeUpload).toHaveBeenCalledWith({ workspaceId: 'workspace', userId: 'actor', artifactId: 'file',
      source: 'agent', abortSignal: expect.any(AbortSignal) });
  });

  it('publishes only the committed file identity, actor, source and actual byte count', async () => {
    await service.createAgentFile(input);
    expect(publishSafely).toHaveBeenCalledTimes(1);
    expect(publishSafely).toHaveBeenCalledWith(EVENT_CATALOG.artifact.created, {
      workspaceId: 'workspace', actor: { id: 'actor', type: AuditActorType.Agent },
      outcome: AuditOutcome.Success, resourceType: 'artifact', resourceId: 'file',
      metadata: { source: 'agent', sizeBytes: 2 },
    }, { subject: 'workspace:workspace/artifact:file' });
  });

  it('skips publication when finalization fails', async () => {
    completeUpload.mockRejectedValueOnce(new Error('Commit failed'));
    await expect(service.createAgentFile(input)).rejects.toThrow('Commit failed');
    expect(publishSafely).not.toHaveBeenCalled();
  });

  it('stops before reserving when cancelled', async () => {
    await expect(service.createAgentFile({ ...input, abortSignal: AbortSignal.abort(new Error('Stopped')) })).rejects.toThrow('Stopped');
    expect(reserveUpload).not.toHaveBeenCalled();
  });

  it('keeps an interrupted write pending for expiry cleanup', async () => {
    uploadFile.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(service.createAgentFile(input)).rejects.toThrow('Storage unavailable');
    expect(completeUpload).not.toHaveBeenCalled();
  });
});
