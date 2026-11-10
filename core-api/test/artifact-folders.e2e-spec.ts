import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { dataSourceOptions } from '@/database/database-config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

describe('Artifact folder persistence (e2e)', () => {
  const db = new DataSource({ ...dataSourceOptions, cache: false });
  const workspaces: string[] = [];

  beforeAll(async () => {
    await db.initialize();
  });

  afterEach(async () => {
    await db.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [
      workspaces.splice(0),
    ]);
  });

  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
  });

  async function createWorkspace() {
    const id = randomUUID();
    await db.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [id, id]);
    workspaces.push(id);
    return id;
  }

  async function createFolder(workspaceId: string, parentFolderId: string | null) {
    const id = randomUUID();
    await db.query(
      'INSERT INTO artifact_folders (id, "workspaceId", "parentFolderId", name) VALUES ($1, $2, $3, $4)',
      [id, workspaceId, parentFolderId, 'Test folder'],
    );
    return id;
  }

  async function createFile(workspaceId: string, parentFolderId: string) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO artifacts (id, "workspaceId", "parentFolderId", name, "mimeType", "objectKey", "sizeBytes", status)
       VALUES ($1, $2, $3, 'test.txt', 'text/plain', $4, 0, 'ready')`,
      [id, workspaceId, parentFolderId, workspaceArtifactKey(workspaceId, id)],
    );
    return id;
  }

  it('rejects a folder or file pointing to a parent in another workspace', async () => {
    const workspace = await createWorkspace();
    const other = await createWorkspace();
    const parent = await createFolder(other, null);

    await expect(createFolder(workspace, parent)).rejects.toMatchObject({
      driverError: { code: '23503', constraint: 'FK_artifact_folders_parent' },
    });
    await expect(createFile(workspace, parent)).rejects.toMatchObject({
      driverError: { code: '23503', constraint: 'FK_artifacts_parent_folder' },
    });
  });

  it('preserves nonempty folders and cascades the whole tree on workspace deletion', async () => {
    const workspace = await createWorkspace();
    const other = await createWorkspace();
    const otherFolder = await createFolder(other, null);
    const root = await createFolder(workspace, null);
    const child = await createFolder(workspace, root);
    const file = await createFile(workspace, child);

    await expect(db.query('DELETE FROM artifact_folders WHERE id = $1', [root])).rejects.toMatchObject({
      driverError: { code: '23503', constraint: 'FK_artifact_folders_parent' },
    });
    await expect(db.query('DELETE FROM artifact_folders WHERE id = $1', [child])).rejects.toMatchObject({
      driverError: { code: '23503', constraint: 'FK_artifacts_parent_folder' },
    });

    await db.query('DELETE FROM workspaces WHERE id = $1', [workspace]);
    await expect(db.query('SELECT id FROM artifacts WHERE id = $1', [file])).resolves.toEqual([]);
    await expect(db.query('SELECT id FROM artifact_folders WHERE id = ANY($1::uuid[])', [
      [root, child, otherFolder],
    ])).resolves.toEqual([{ id: otherFolder }]);
  });
});
