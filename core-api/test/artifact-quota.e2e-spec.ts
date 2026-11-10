import {
  ARTIFACT_MAX_FILE_BYTES,
  ARTIFACT_WORKSPACE_QUOTA_BYTES,
  ArtifactQuotaService,
} from '@/modules/artifacts/artifact-quota.service';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private artifact quota transactions (e2e)', () => {
  const quota = new ArtifactQuotaService();
  let app: TestApp;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
  });

  beforeEach(async () => {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id', ['Quota ' + randomUUID()],
    );
    workspaceId = row.id;
  });

  afterEach(async () => {
    if (workspaceId) {
      await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    }
  });

  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  const meter = async () => (await app.dataSource.query<{
    quotaBytes: string | null; usedBytes: string; reservedBytes: string;
  }[]>(
    'SELECT "quotaBytes","usedBytes","reservedBytes" FROM workspace_storage_usage WHERE "workspaceId"=$1',
    [workspaceId],
  ))[0];

  const setQuota = async (bytes: number) => {
    await app.dataSource.query(
      `INSERT INTO workspace_storage_usage ("workspaceId","quotaBytes") VALUES ($1,$2)
       ON CONFLICT ("workspaceId") DO UPDATE SET "quotaBytes"=EXCLUDED."quotaBytes"`,
      [workspaceId, bytes],
    );
  };

  it('creates the meter lazily and rolls back a reservation with its caller', async () => {
    expect(await meter()).toBeUndefined();
    await expect(app.dataSource.transaction(async manager => {
      expect(await quota.reserve(manager, workspaceId, 7)).toBe(true);
      throw new Error('artifact insert failed');
    })).rejects.toThrow('artifact insert failed');
    expect(await meter()).toBeUndefined();

    await expect(app.dataSource.transaction(manager =>
      quota.reserve(manager, workspaceId, 7))).resolves.toBe(true);
    expect(await meter()).toEqual({ quotaBytes: null, usedBytes: '0', reservedBytes: '7' });
  });

  it('serializes concurrent reservations against the same workspace cap', async () => {
    await setQuota(10);
    const reserve = () => app.dataSource.transaction(manager =>
      quota.reserve(manager, workspaceId, 7));
    expect((await Promise.all([reserve(), reserve()])).sort()).toEqual([false, true]);
    expect(await meter()).toEqual({ quotaBytes: '10', usedBytes: '0', reservedBytes: '7' });
  });

  it('enforces the default cap and respects an explicit zero override', async () => {
    await app.dataSource.query(
      'INSERT INTO workspace_storage_usage ("workspaceId","usedBytes") VALUES ($1,$2)',
      [workspaceId, ARTIFACT_WORKSPACE_QUOTA_BYTES - 1],
    );
    await app.dataSource.transaction(async manager => {
      expect(await quota.reserve(manager, workspaceId, 1)).toBe(true);
      expect(await quota.reserve(manager, workspaceId, 1)).toBe(false);
    });
    await setQuota(0);
    await expect(app.dataSource.transaction(manager =>
      quota.reserve(manager, workspaceId, 1))).resolves.toBe(false);
  });

  it('moves reservations to used bytes and rejects transitions that would underflow', async () => {
    await app.dataSource.transaction(async manager => {
      expect(await quota.reserve(manager, workspaceId, 8)).toBe(true);
      expect(await quota.reserve(manager, workspaceId, 3)).toBe(true);
    });
    // Previously reserved bytes can settle after a quota override is lowered.
    await setQuota(1);
    await app.dataSource.transaction(async manager => {
      expect(await quota.commit(manager, workspaceId, 8)).toBe(true);
      expect(await quota.commit(manager, workspaceId, 8)).toBe(false);
      expect(await quota.releaseReserved(manager, workspaceId, 4)).toBe(false);
      expect(await quota.releaseReserved(manager, workspaceId, 3)).toBe(true);
      expect(await quota.releaseUsed(manager, workspaceId, 9)).toBe(false);
      expect(await quota.releaseUsed(manager, workspaceId, 2)).toBe(true);
    });
    expect(await meter()).toEqual({ quotaBytes: '1', usedBytes: '6', reservedBytes: '0' });
  });

  it('requires a transaction and rejects invalid file sizes before writing', async () => {
    await expect(quota.reserve(app.dataSource.manager, workspaceId, 1)).rejects.toThrow('transaction');
    await app.dataSource.transaction(async manager => {
      for (const bytes of [-1, 0.5, NaN, ARTIFACT_MAX_FILE_BYTES + 1]) {
        await expect(quota.reserve(manager, workspaceId, bytes)).rejects.toBeInstanceOf(RangeError);
      }
    });
    expect(await meter()).toBeUndefined();
  });
});
