import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import type { StorageService } from '@/modules/storage/storage.service';
import type { ArtifactUploadReservationService } from './artifact-upload-reservation.service';
import type { ArtifactUploadCompletionService } from './artifact-upload-completion.service';
import { ArtifactBufferService } from './artifact-buffer.service';

describe('ArtifactBufferService', () => {
  const reserveUpload = jest.fn();
  const completeUpload = jest.fn();
  const uploadFile = jest.fn();
  const service = new ArtifactBufferService(
    { reserveUpload } as unknown as ArtifactUploadReservationService,
    { completeUpload } as unknown as ArtifactUploadCompletionService,
    { uploadFile } as unknown as StorageService,
  );
  const input = { workspaceId: 'workspace', userId: 'actor', name: '../report.txt', buffer: Buffer.from('é'), contentType: 'text/plain' };

  beforeEach(() => {
    jest.resetAllMocks();
    reserveUpload.mockResolvedValue({ artifact: { id: 'file' }, upload: { expiresAt: new Date(Date.now() + 60_000) } });
    completeUpload.mockResolvedValue({ id: 'file', status: 'ready' });
  });

  it('reserves actual bytes and uses a server-owned staging key before completion', async () => {
    await expect(service.createAgentFile(input)).resolves.toEqual({ id: 'file', status: 'ready' });
    expect(reserveUpload).toHaveBeenCalledWith({ workspaceId: 'workspace', createdByUserId: 'actor', name: input.name,
      contentType: 'text/plain', sizeBytes: 2, source: 'agent', abortSignal: undefined });
    expect(uploadFile).toHaveBeenCalledWith(workspaceArtifactUploadKey('workspace', 'file'), input.buffer,
      ARTIFACT_BUCKET, 'text/plain', expect.any(AbortSignal));
    expect(completeUpload).toHaveBeenCalledWith({ workspaceId: 'workspace', userId: 'actor', artifactId: 'file',
      source: 'agent', abortSignal: expect.any(AbortSignal) });
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
