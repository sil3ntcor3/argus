import {
  ARTIFACT_BUCKET,
  workspaceArtifactKey,
  workspaceArtifactUploadKey,
} from '@/common/constants/artifact-storage';
import { StorageService } from '@/modules/storage/storage.service';
import { RustFsClient } from '@/modules/storage/rustfs.client';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private artifact final copy (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  function fixture() {
    const storage = app.app.get(StorageService);
    const s3 = app.app.get(RustFsClient).getClient();
    const workspaceId = randomUUID();
    const artifactId = randomUUID();
    const input = { workspaceId, artifactId, contentType: 'text/plain', sizeBytes: 3 };
    const staging = workspaceArtifactUploadKey(workspaceId, artifactId);
    const final = workspaceArtifactKey(workspaceId, artifactId);
    return {
      storage, s3, input, staging, final,
      put: (key: string, content: string, mimeType = 'text/plain') =>
        storage.uploadFile(key, Buffer.from(content), ARTIFACT_BUCKET, mimeType),
      read: async (Key: string) =>
        (await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key }))).Body?.transformToString(),
      cleanup: () => Promise.all([staging, final].map(key => storage.deleteFile(key, ARTIFACT_BUCKET))),
    };
  }

  it('keeps the first published bytes on retries after staging is overwritten or removed', async () => {
    const f = fixture();
    try {
      await f.put(f.staging, 'one');
      await f.storage.publishArtifactUpload(f.input);
      expect(await f.read(f.final)).toBe('one');
      const head = await f.s3.send(new HeadObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: f.final }));
      expect(head.Metadata?.['argus-artifact-id']).toBe(f.input.artifactId);
      expect(head.ContentType).toBe(f.input.contentType);

      await f.put(f.staging, 'two');
      await f.storage.publishArtifactUpload(f.input);
      expect(await f.read(f.staging)).toBe('two');
      expect(await f.read(f.final)).toBe('one');

      await f.storage.deleteFile(f.staging, ARTIFACT_BUCKET);
      await expect(f.storage.publishArtifactUpload(f.input)).resolves.toBeUndefined();
      expect(await f.read(f.final)).toBe('one');
    } finally {
      await f.cleanup();
    }
  });

  it('rejects mismatched staging bytes or media and never overwrites an unmarked destination', async () => {
    const f = fixture();
    try {
      for (const [content, type] of [['too long', 'text/plain'], ['one', 'application/pdf']]) {
        await f.put(f.staging, content, type);
        await expect(f.storage.publishArtifactUpload(f.input)).rejects.toBeInstanceOf(ConflictException);
        await expect(f.read(f.final)).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
      }
      await f.put(f.staging, 'one');
      await f.put(f.final, 'two');
      await expect(f.storage.publishArtifactUpload(f.input)).rejects.toBeInstanceOf(ConflictException);
      expect(await f.read(f.final)).toBe('two');
    } finally {
      await f.cleanup();
    }
  });
});
