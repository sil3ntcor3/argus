import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private workspace storage usage (e2e)', () => {
  let app: TestApp;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
  });

  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
      ['Storage meter ' + randomUUID()],
    );
    workspaceId = workspace.id;
  });

  afterEach(async () => {
    if (workspaceId) {
      await app.dataSource.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    }
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  it('creates a meter only when requested, with zero balances and no quota override', async () => {
    expect(await app.dataSource.query(
      'SELECT * FROM workspace_storage_usage WHERE "workspaceId" = $1',
      [workspaceId],
    )).toEqual([]);
    const [meter] = await app.dataSource.query<{
      quotaBytes: string | null; usedBytes: string; reservedBytes: string; updatedAt: Date;
    }[]>(
      'INSERT INTO workspace_storage_usage ("workspaceId") VALUES ($1) RETURNING *',
      [workspaceId],
    );
    expect(meter).toMatchObject({
      quotaBytes: null, usedBytes: '0', reservedBytes: '0', updatedAt: expect.any(Date),
    });
    await expect(app.dataSource.query(
      'INSERT INTO workspace_storage_usage ("workspaceId") VALUES ($1)',
      [workspaceId],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['quotaBytes', 'usedBytes', 'reservedBytes'])(
    'enforces the exact byte range on %s',
    async (column) => {
      const sql = `INSERT INTO workspace_storage_usage ("workspaceId", "${column}") VALUES ($1, $2)`;
      await expect(app.dataSource.query(sql, [workspaceId, '-1']))
        .rejects.toMatchObject({ code: '23514' });
      await expect(app.dataSource.query(sql, [workspaceId, '9007199254740992']))
        .rejects.toMatchObject({ code: '23514' });
      await app.dataSource.query(sql, [workspaceId, column === 'quotaBytes' ? '0' : '9007199254740991']);
    },
  );

  it('rejects a missing workspace and removes usage when its workspace is deleted', async () => {
    await expect(app.dataSource.query(
      'INSERT INTO workspace_storage_usage ("workspaceId") VALUES ($1)',
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23503' });
    await app.dataSource.query(
      'INSERT INTO workspace_storage_usage ("workspaceId") VALUES ($1)',
      [workspaceId],
    );
    await app.dataSource.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    expect(await app.dataSource.query(
      'SELECT * FROM workspace_storage_usage WHERE "workspaceId" = $1',
      [workspaceId],
    )).toEqual([]);
  });
});
