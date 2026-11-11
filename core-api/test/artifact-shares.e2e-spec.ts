import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { dataSourceOptions } from '@/database/database-config';
import { ArtifactShare } from '@/modules/artifacts/entities/artifact-share.entity';
import { User } from '@/modules/auth/entities/user.entity';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

describe('Artifact share persistence (e2e)', () => {
  const db = new DataSource({ ...dataSourceOptions, cache: false });
  const workspaces: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    await db.initialize();
  });

  afterEach(async () => {
    await db.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaces.splice(0)]);
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users.splice(0)]);
  });

  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
  });

  async function createRecipient() {
    const id = randomUUID();
    await db.getRepository(User).insert({ id, name: 'Recipient', email: `${id}@example.test`, emailVerified: true });
    users.push(id);
    return id;
  }

  async function createFile() {
    const workspaceId = randomUUID();
    await db.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspaceId, workspaceId]);
    workspaces.push(workspaceId);
    const id = randomUUID();
    await db.query(
      `INSERT INTO artifacts (id, "workspaceId", name, "mimeType", "objectKey", "sizeBytes", status)
       VALUES ($1, $2, 'test.txt', 'text/plain', $3, 0, 'ready')`,
      [id, workspaceId, workspaceArtifactKey(workspaceId, id)],
    );
    return id;
  }

  it('records a creation time and permits one record per file and recipient', async () => {
    const artifactId = await createFile();
    const userId = await createRecipient();
    const shares = db.getRepository(ArtifactShare);
    await shares.insert({ artifactId, userId });
    const share = await shares.findOneByOrFail({ artifactId, userId });
    expect(share.createdAt).toBeInstanceOf(Date);
    await expect(shares.insert({ artifactId, userId })).rejects.toMatchObject({
      driverError: { code: '23505', constraint: 'UQ_artifact_shares_artifact_user' },
    });
    await expect(shares.insert({ artifactId: randomUUID(), userId })).rejects.toMatchObject({
      driverError: { code: '23503', constraint: 'FK_artifact_shares_artifact' },
    });
    await expect(shares.insert({ artifactId, userId: randomUUID() })).rejects.toMatchObject({
      driverError: { code: '23503', constraint: 'FK_artifact_shares_user' },
    });
  });

  it('removes only the affected records when files or recipients are deleted', async () => {
    const artifactId = await createFile();
    const otherFile = await createFile();
    const userId = await createRecipient();
    const otherUser = await createRecipient();
    const shares = db.getRepository(ArtifactShare);
    await shares.insert([
      { artifactId, userId },
      { artifactId: otherFile, userId },
      { artifactId: otherFile, userId: otherUser },
    ]);

    await db.query('DELETE FROM artifacts WHERE id = $1', [artifactId]);
    await expect(shares.countBy({ artifactId })).resolves.toBe(0);
    await expect(shares.countBy({ artifactId: otherFile })).resolves.toBe(2);

    await db.getRepository(User).delete(userId);
    await expect(shares.countBy({ userId })).resolves.toBe(0);
    await expect(shares.countBy({ artifactId: otherFile, userId: otherUser })).resolves.toBe(1);
  });
});
