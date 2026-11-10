import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private workspace artifact records (e2e)', () => {
  let app: TestApp;
  let workspaceId: string;
  let creatorId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
  });

  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
      ['Artifact workspace ' + randomUUID()],
    );
    workspaceId = workspace.id;
    const [user] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO users (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id',
      ['Artifact creator', randomUUID() + '@example.test'],
    );
    creatorId = user.id;
  });

  afterEach(async () => {
    if (workspaceId) await app.dataSource.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    if (creatorId) await app.dataSource.query('DELETE FROM users WHERE id = $1', [creatorId]);
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  const key = (workspace: string, id: string) => `workspaces/${workspace}/${id}/file`;
  async function pending({
    id = randomUUID(), owner = workspaceId, objectKey = key(owner, id),
    bytes = '0', expiry = new Date('2099-01-01T00:00:00Z'),
  }: {
    id?: string; owner?: string; objectKey?: string; bytes?: string; expiry?: Date | null;
  } = {}) {
    const [row] = await app.dataSource.query<Record<string, unknown>[]>(
      `INSERT INTO artifacts
        (id,"workspaceId","createdByUserId",name,"mimeType","objectKey","sizeBytes","expiresAt")
       VALUES ($1,$2,$3,$4,'text/plain',$5,$6,$7) RETURNING *`,
      [id, owner, creatorId, 'Display name only.txt', objectKey, bytes, expiry],
    );
    return row;
  }

  it('stores an exact byte count and keeps the display name out of the object key', async () => {
    const id = randomUUID();
    const row = await pending({ id, bytes: '9007199254740991' });
    expect(row).toMatchObject({
      id, workspaceId, createdByUserId: creatorId, name: 'Display name only.txt',
      objectKey: key(workspaceId, id), sizeBytes: '9007199254740991',
      source: 'upload', status: 'pending', metadata: {},
      expiresAt: expect.any(Date), createdAt: expect.any(Date), updatedAt: expect.any(Date),
    });
  });

  it('rejects keys for another workspace or another file and invalid byte counts', async () => {
    const id = randomUUID();
    await expect(pending({ id, objectKey: key(randomUUID(), id) }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pending({ id, objectKey: key(workspaceId, randomUUID()) }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pending({ bytes: '-1' })).rejects.toMatchObject({ code: '23514' });
    await expect(pending({ bytes: '9007199254740992' })).rejects.toMatchObject({ code: '23514' });
  });

  it('requires a pending deadline and rejects invalid sources, states, and metadata', async () => {
    await expect(pending({ expiry: null })).rejects.toMatchObject({ code: '23514' });
    const id = randomUUID();
    await pending({ id });
    for (const sql of [
      "UPDATE artifacts SET source='unknown' WHERE id=$1",
      "UPDATE artifacts SET status='unknown' WHERE id=$1",
      "UPDATE artifacts SET metadata='[]' WHERE id=$1",
    ]) {
      await expect(app.dataSource.query(sql, [id])).rejects.toMatchObject({ code: '23514' });
    }
    await app.dataSource.query("UPDATE artifacts SET status='ready' WHERE id=$1", [id]);
    const [row] = await app.dataSource.query<{ expiresAt: Date }[]>(
      'SELECT "expiresAt" FROM artifacts WHERE id=$1', [id],
    );
    expect(row.expiresAt.toISOString()).toBe('2099-01-01T00:00:00.000Z');
  });

  it('clears a deleted creator and removes records only with their workspace', async () => {
    await expect(pending({ owner: randomUUID() })).rejects.toMatchObject({ code: '23503' });
    const id = randomUUID();
    await pending({ id });
    await app.dataSource.query('DELETE FROM users WHERE id = $1', [creatorId]);
    const rows = () => app.dataSource.query<{ createdByUserId: string | null }[]>(
      'SELECT "createdByUserId" FROM artifacts WHERE id=$1', [id],
    );
    expect(await rows()).toEqual([{ createdByUserId: null }]);
    await app.dataSource.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    expect(await rows()).toEqual([]);
  });
});
