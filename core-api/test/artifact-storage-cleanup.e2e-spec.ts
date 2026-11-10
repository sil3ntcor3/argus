import { StorageService } from '@/modules/storage/storage.service';
import { RustFsClient } from '@/modules/storage/rustfs.client';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private artifact storage cleanup (e2e)', () => {
  jest.setTimeout(90_000);
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  it('sweeps past the first object-store page without touching a sibling prefix', async () => {
    const storage = app.app.get(StorageService);
    const s3 = app.app.get(RustFsClient).getClient();
    const Bucket = 'artifacts';
    const workspaceId = randomUUID();
    const prefix = `workspaces/${workspaceId}/`;
    const siblingPrefix = `workspaces/${workspaceId}-sibling/`;
    const sibling = siblingPrefix + 'retained';
    const keys = Array.from({ length: 1001 }, (_, index) => prefix + index.toString().padStart(4, '0'));
    const list = (Prefix: string) => s3.send(new ListObjectsV2Command({ Bucket, Prefix }));
    try {
      // Seed with the service once to provision the bucket on older installations.
      await storage.uploadFile(sibling, Buffer.from('other workspace'), Bucket);
      for (let start = 0; start < keys.length; start += 25) {
        await Promise.all(keys.slice(start, start + 25).map(Key => s3.send(
          new PutObjectCommand({ Bucket, Key, Body: Buffer.from('fixture') }),
        )));
      }
      expect((await list(prefix)).IsTruncated).toBe(true);

      await expect(storage.deleteWorkspaceArtifacts(workspaceId)).resolves.toEqual({
        deleted: 1001, failed: 0,
      });
      expect((await list(prefix)).Contents ?? []).toEqual([]);
      expect((await list(siblingPrefix)).Contents?.map(row => row.Key)).toEqual([sibling]);
    } finally {
      // Limit cleanup to the exact synthetic keys, even if the tested sweep failed.
      const fixtures = [...keys, sibling];
      for (let start = 0; start < fixtures.length; start += 1000) {
        await s3.send(new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: fixtures.slice(start, start + 1000).map(Key => ({ Key })) },
        }));
      }
    }
  });
});
