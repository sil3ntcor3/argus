import {
  ARTIFACT_BUCKET,
  workspaceArtifactKey,
  workspaceArtifactUploadKey,
} from '@/common/constants/artifact-storage';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactUploadCompletionService } from '@/modules/artifacts/artifact-upload-completion.service';
import { ArtifactUploadReservationService } from '@/modules/artifacts/artifact-upload-reservation.service';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { RustFsClient } from '@/modules/storage/rustfs.client';
import { StorageService } from '@/modules/storage/storage.service';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private artifact upload completion (e2e)', () => {
  let app: TestApp;
  let storage: StorageService;
  let quota: ArtifactQuotaService;
  let reservations: ArtifactUploadReservationService;
  let completion: ArtifactUploadCompletionService;
  let workspaceId: string;
  let userId: string;
  let pending: WorkspaceArtifact;
  let staging: string;
  let final: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    storage = app.app.get(StorageService);
    quota = new ArtifactQuotaService();
    reservations = new ArtifactUploadReservationService(app.dataSource, storage, quota);
    completion = new ArtifactUploadCompletionService(app.dataSource, storage, quota);
  });

  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
      ['Artifact completion ' + randomUUID()],
    );
    workspaceId = workspace.id;
    const [user] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO users (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id',
      ['Artifact author', randomUUID() + '@example.test'],
    );
    userId = user.id;
    ({ artifact: pending } = await reservations.reserveUpload({
      workspaceId, createdByUserId: userId, name: 'Complete.txt', contentType: 'text/plain', sizeBytes: 3,
    }));
    staging = workspaceArtifactUploadKey(workspaceId, pending.id);
    final = workspaceArtifactKey(workspaceId, pending.id);
  });

  afterEach(async () => {
    if (staging && final) {
      await Promise.all([staging, final].map(key => storage.deleteFile(key, ARTIFACT_BUCKET)));
    }
    if (workspaceId) await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    if (userId) await app.dataSource.query('DELETE FROM users WHERE id=$1', [userId]);
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  const input = () => ({ workspaceId, userId, artifactId: pending.id });
  const record = () => app.dataSource.getRepository(WorkspaceArtifact).findOneByOrFail({ id: pending.id });
  const stage = (content = 'one') => storage.uploadFile(staging, Buffer.from(content), ARTIFACT_BUCKET, 'text/plain');
  const readFinal = async () => {
    const response = await app.app.get(RustFsClient).getClient().send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET, Key: final,
    }));
    return response.Body?.transformToString();
  };
  const usage = async () => (await app.dataSource.query<{ usedBytes: string; reservedBytes: string }[]>(
    'SELECT "usedBytes","reservedBytes" FROM workspace_storage_usage WHERE "workspaceId"=$1',
    [workspaceId],
  ))[0];

  it('settles the reservation once across concurrent completions and staging replays', async () => {
    await stage();
    const results = await Promise.all([
      completion.completeUpload(input()), completion.completeUpload(input()),
    ]);
    expect(results.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: pending.id, status: 'ready' }, { id: pending.id, status: 'ready' },
    ]);
    await stage('two');
    expect(await completion.completeUpload(input())).toMatchObject({ status: 'ready' });
    expect(await record()).toMatchObject({ status: 'ready', expiresAt: pending.expiresAt });
    expect(await usage()).toEqual({ usedBytes: '3', reservedBytes: '0' });
    expect(await readFinal()).toBe('one');
  });

  it('does not publish an expired upload or expose a file across workspaces or creators', async () => {
    await stage();
    await expect(completion.completeUpload({ ...input(), workspaceId: randomUUID() }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(completion.completeUpload({ ...input(), userId: randomUUID() }))
      .rejects.toBeInstanceOf(NotFoundException);
    await app.dataSource.getRepository(WorkspaceArtifact).update(pending.id, { expiresAt: new Date(0) });
    await expect(completion.completeUpload(input())).rejects.toBeInstanceOf(ConflictException);
    await expect(readFinal()).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    expect(await record()).toMatchObject({ status: 'pending' });
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '3' });
  });

  it('keeps the reservation when the object has not arrived', async () => {
    await expect(completion.completeUpload(input())).rejects.toBeInstanceOf(NotFoundException);
    expect(await record()).toMatchObject({ status: 'pending' });
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '3' });
    await stage();
    expect(await completion.completeUpload(input())).toMatchObject({ status: 'ready' });
  });

  it('aborts stalled storage I/O, releases the reservation locks, and permits retry', async () => {
    const deadline = new AbortController();
    const server = createServer((_request, response) => {
      // The SDK must cancel this connected request. The fallback prevents a
      // regression from leaving the test itself blocked forever.
      const fallback = setTimeout(() => response.destroy(), 500);
      response.once('close', () => clearTimeout(fallback));
      deadline.abort(new Error('fixture storage timeout'));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP fixture address');
    const stalled = new S3Client({
      endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true, maxAttempts: 1,
      region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    });
    const client = jest.spyOn(app.app.get(RustFsClient), 'getClient').mockReturnValue(stalled);
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    try {
      await expect(completion.completeUpload(input())).rejects.toMatchObject({ name: 'AbortError' });
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {
      timeout.mockRestore();
      client.mockRestore();
      stalled.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    expect(await record()).toMatchObject({ status: 'pending' });
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '3' });
    await stage();
    expect(await completion.completeUpload(input())).toMatchObject({ status: 'ready' });
  });

  it('recovers a verified copy after a failed accounting transaction', async () => {
    await stage();
    const rejected = jest.spyOn(quota, 'commit').mockRejectedValueOnce(new Error('fixture accounting failure'));
    try {
      await expect(completion.completeUpload(input())).rejects.toThrow('fixture accounting failure');
    } finally {
      rejected.mockRestore();
    }
    expect(await record()).toMatchObject({ status: 'pending' });
    expect(await usage()).toEqual({ usedBytes: '0', reservedBytes: '3' });
    expect(await readFinal()).toBe('one');
    await stage('two');
    expect(await completion.completeUpload(input())).toMatchObject({ status: 'ready' });
    expect(await usage()).toEqual({ usedBytes: '3', reservedBytes: '0' });
    expect(await readFinal()).toBe('one');
  });
});
