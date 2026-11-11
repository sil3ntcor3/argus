import { ARTIFACT_BUCKET, workspaceArtifactKey, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private artifact POST policy (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  it('enforces exact bytes, MIME type, and object key in the real object store', async () => {
    const storage = app.app.get(StorageService);
    const workspaceId = randomUUID();
    const artifactId = randomUUID();
    const key = workspaceArtifactUploadKey(workspaceId, artifactId);
    const finalKey = workspaceArtifactKey(workspaceId, artifactId);
    const wrongKey = workspaceArtifactUploadKey(randomUUID(), artifactId);
    const contentType = 'text/plain';
    const content = 'exact bytes';
    const startedAt = Date.now();
    const upload = await storage.getPresignedArtifactUpload({
      workspaceId, artifactId, contentType, sizeBytes: Buffer.byteLength(content),
    });
    expect(upload.fields.key).toBe(key);
    expect(upload.expiresAt.getTime()).toBeGreaterThan(startedAt + 14 * 60 * 1000);
    expect(upload.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);

    const post = (payload: string, overrides: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [name, value] of Object.entries({ ...upload.fields, ...overrides })) {
        form.append(name, value);
      }
      form.append('file', new Blob([payload], { type: overrides['Content-Type'] ?? contentType }), 'user-name.txt');
      return fetch(upload.url, { method: 'POST', body: form });
    };
    try {
      expect((await post(content)).status).toBe(204);
      for (const [payload, fields] of [
        [content + 'x', {}],
        [content.slice(1), {}],
        [content, { key: wrongKey }],
        [content, { key: finalKey }],
        [content, { 'Content-Type': 'application/pdf' }],
      ] as const) {
        expect((await post(payload, fields)).status).toBe(400);
      }

      const signed = await storage.getPresignedDownloadUrl({ bucket: ARTIFACT_BUCKET, key });
      const retrieved = await fetch(signed.url);
      expect(retrieved.status).toBe(200);
      expect(await retrieved.text()).toBe(content);
      for (const missing of [wrongKey, finalKey]) {
        const signedMissing = await storage.getPresignedDownloadUrl({ bucket: ARTIFACT_BUCKET, key: missing });
        expect((await fetch(signedMissing.url)).status).toBe(404);
      }
    } finally {
      await Promise.all([key, wrongKey, finalKey].map(fixture => storage.deleteFile(fixture, ARTIFACT_BUCKET)));
    }
  });
});
