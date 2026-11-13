/* eslint-disable @typescript-eslint/require-await */
import { StreamableFile } from '@nestjs/common';
import { ProjectFilesService, PROJECT_FILE_MAX_BYTES } from './project-files.service';
import { WorkspaceArtifact } from '../artifacts/entities/workspace-artifact.entity';

describe('ProjectFilesService', () => {
  function setup() {
    const project = { id: 'project', archivedAt: null as Date | null };
    const artifact = { id: 'file', name: 'scope.txt', sizeBytes: '12', mimeType: 'text/plain', status: 'ready', objectKey: 'workspaces/workspace/file/file' };
    const links: { id: string; name: string; sizeBytes: string }[] = [];
    const linkRepo = { existsBy: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0), insert: jest.fn(), findOne: jest.fn().mockResolvedValue({ artifact }) };
    const artifactRepo = { findOne: jest.fn().mockResolvedValue(artifact) };
    const manager = { query: jest.fn(async (sql: string) => sql.includes('FROM projects') ? [project] : []), findOne: jest.fn().mockResolvedValue(artifact), getRepository: () => linkRepo, delete: jest.fn() };
    const db = { transaction: jest.fn(async (work: (m: unknown) => unknown) => work(manager)), query: jest.fn(async (sql: string) => sql.includes('FROM projects') ? [project] : links), getRepository: (entity: unknown) => entity === WorkspaceArtifact ? artifactRepo : linkRepo };
    const reservation = { reserveUpload: jest.fn().mockResolvedValue({ artifact: { id: 'file' }, upload: { url: 'http://storage.invalid', fields: {}, expiresAt: new Date() } }) };
    const completion = { completeUpload: jest.fn().mockResolvedValue(artifact) };
    const storage = { getFile: jest.fn().mockResolvedValue({ file: new StreamableFile(Buffer.from('Private text')) }) };
    const service = new ProjectFilesService(db as never, reservation as never, completion as never, storage as never);
    return { service, project, artifact, links, linkRepo, artifactRepo, manager, db, reservation, completion, storage };
  }
  it('reserves only validated text files through existing private artifact publication', async () => {
    const { service, reservation } = setup();
    expect(await service.presign('project', 'workspace', 'user', { fileName: 'NOTES.MD', sizeBytes: 12 })).toHaveProperty('artifactId', 'file');
    expect(reservation.reserveUpload).toHaveBeenCalledWith({ workspaceId: 'workspace', createdByUserId: 'user', name: 'NOTES.MD', contentType: 'text/markdown', sizeBytes: 12 });
  });
  it.each([['image.png', 1], ['scope.txt', 0], ['scope.txt', PROJECT_FILE_MAX_BYTES + 1]])('rejects invalid uploads without reserving (%s, %s)', async (fileName, sizeBytes) => {
    const { service, reservation } = setup();
    await expect(service.presign('project', 'workspace', 'user', { fileName, sizeBytes })).rejects.toThrow();
    expect(reservation.reserveUpload).not.toHaveBeenCalled();
  });
  it('checks archived state before publication and reserves nothing', async () => {
    const { service, project, reservation, completion } = setup(); project.archivedAt = new Date();
    await expect(service.presign('project', 'workspace', 'user', { fileName: 'scope.txt', sizeBytes: 12 })).rejects.toMatchObject({ status: 400 });
    await expect(service.complete('project', 'workspace', 'user', 'file')).rejects.toMatchObject({ status: 400 });
    expect(reservation.reserveUpload).not.toHaveBeenCalled(); expect(completion.completeUpload).not.toHaveBeenCalled();
  });
  it('rejects a foreign file before any storage write', async () => {
    const { service, artifactRepo, completion } = setup(); artifactRepo.findOne.mockResolvedValue(null);
    await expect(service.complete('project', 'workspace', 'user', 'foreign')).rejects.toMatchObject({ status: 404 });
    expect(completion.completeUpload).not.toHaveBeenCalled();
  });
  it('revalidates file type and bytes when completion receives an arbitrary owned artifact id', async () => {
    const { service, artifact, completion } = setup(); artifact.name = 'unexpected.zip';
    await expect(service.complete('project', 'workspace', 'user', 'file')).rejects.toMatchObject({ status: 400 });
    expect(completion.completeUpload).not.toHaveBeenCalled();
  });
  it('keeps completion idempotent even when every project slot is full', async () => {
    const { service, linkRepo } = setup(); linkRepo.existsBy.mockResolvedValue(true); linkRepo.count.mockResolvedValue(5);
    await service.complete('project', 'workspace', 'user', 'file');
    expect(linkRepo.count).not.toHaveBeenCalled(); expect(linkRepo.insert).not.toHaveBeenCalled();
  });
  it('retains the published workspace file when the final attachment slot was taken', async () => {
    const { service, linkRepo, completion } = setup(); linkRepo.count.mockResolvedValue(5);
    await expect(service.complete('project', 'workspace', 'user', 'file')).rejects.toThrow('stays in Files');
    expect(completion.completeUpload).toHaveBeenCalled(); expect(linkRepo.insert).not.toHaveBeenCalled();
  });
  it('bounds actual object bytes even if stored file metadata is wrong', async () => {
    const { service, storage } = setup(); storage.getFile.mockResolvedValue({ file: new StreamableFile(Buffer.alloc(PROJECT_FILE_MAX_BYTES + 1)) });
    await expect(service.readText('project', 'workspace', 'file')).rejects.toMatchObject({ status: 413 });
  });
  it('caps prompt text to 8,000 per file and 30,000 overall while retaining every file identity', async () => {
    const { service } = setup();
    jest.spyOn(service, 'list').mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: 'scope.txt', mimeType: 'text/plain', sizeBytes: 10000, createdByName: null, attachedAt: new Date() })));
    const read = jest.spyOn(service, 'readText').mockImplementation(async (_p, _w, id) => ({ id, name: 'scope.txt', content: 'x'.repeat(10000), totalChars: 10000 }));
    const context = await service.contextFiles('project', { perFile: 8000, total: 30000 }, 'workspace');
    expect(context.map(f => f.content.length)).toEqual([8000, 8000, 8000, 6000, 0]);
    expect(read).toHaveBeenCalledWith('project', 'workspace', '4');
  });
});
