import { dataSourceOptions } from '@/database/database-config';
import { AssetGroupAssetService } from '@/modules/asset-group/asset-group-asset.service';
import { AssetGroupAsset } from '@/modules/asset-group/entities/asset-groups-assets.entity';
import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import { Asset } from '@/modules/assets/entities/assets.entity';
import {
  lockProjectScope,
  syncProjectScope,
} from '@/modules/projects/project-scope-sync';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource, type EntityManager } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Durable legacy project removals (e2e)', () => {
  let ds: DataSource,
    user: string,
    workspace: string,
    project: string,
    asset: string;
  const insert = async (sql: string, args: unknown[]) =>
    (await ds.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
  const service = (manager: EntityManager = ds.manager) =>
    new AssetGroupAssetService(
      manager.getRepository(AssetGroup),
      manager.getRepository(AssetGroupAsset),
      manager.getRepository(Asset),
    );
  const rules = () =>
    ds.query<{ mode: string; type: string; value: string }[]>(
      'SELECT mode,type,value FROM project_scope_rules WHERE "projectId"=$1 ORDER BY mode',
      [project],
    );
  const members = () =>
    ds.query<{ assetId: string }[]>(
      'SELECT "assetId" FROM project_assets WHERE "projectId"=$1',
      [project],
    );
  const seed = async () => {
    await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'asset', asset],
    );
    await ds.transaction((manager) =>
      syncProjectScope(manager, project, workspace),
    );
  };
  beforeAll(async () => {
    ds = new DataSource({
      ...dataSourceOptions,
      migrationsRun: false,
      cache: false,
      logging: false,
    });
    await ds.initialize();
    user = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus durable removal', randomUUID() + '@example.test'],
    );
    workspace = await insert(
      'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
      [randomUUID(), user],
    );
    project = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), workspace],
    );
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['remove.argus.test', 'DOMAIN', workspace],
    );
    asset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['remove.argus.test', target],
    );
  });
  beforeEach(async () => {
    await ds.query('DELETE FROM project_assets WHERE "projectId"=$1', [
      project,
    ]);
    await ds.query('DELETE FROM project_scope_rules WHERE "projectId"=$1', [
      project,
    ]);
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await cleanupE2eData(ds, {
        workspaceIds: [workspace].filter(Boolean),
        userIds: [user].filter(Boolean),
      });
      await ds.destroy();
    }
  });

  it('saves one exact exclusion and removes membership without deleting the asset or allowing re-addition', async () => {
    await seed();
    expect(
      await service().removeManyAssets(project, [asset, asset], workspace),
    ).toEqual({
      message: `1 assets successfully removed from asset group "${project}"`,
    });
    expect(await rules()).toEqual([
      { mode: 'exclude', type: 'asset', value: asset },
      { mode: 'include', type: 'asset', value: asset },
    ]);
    expect(await members()).toEqual([]);
    expect(
      await ds.transaction((manager) =>
        syncProjectScope(manager, project, workspace),
      ),
    ).toEqual({ added: [], removed: 0 });
    expect(await ds.getRepository(Asset).existsBy({ id: asset })).toBe(true);
  });

  it('validates the whole batch and preserves legacy tenant and missing-member responses before adding exclusions', async () => {
    await seed();
    for (const ids of [[], [randomUUID()], [asset, randomUUID()]])
      await expect(
        service().removeManyAssets(project, ids, workspace),
      ).rejects.toMatchObject({ status: 404 });
    await expect(
      service().removeManyAssets(project, [asset], randomUUID()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service().removeManyAssets(randomUUID(), [asset], workspace),
    ).rejects.toMatchObject({ status: 404 });
    expect(await rules()).toEqual([
      { mode: 'include', type: 'asset', value: asset },
    ]);
    expect(await members()).toEqual([{ assetId: asset }]);
  });

  it('rolls the new exclusion back when removing membership fails', async () => {
    await seed();
    const db = ds.createQueryRunner();
    await db.connect();
    await db.startTransaction();
    const failure = new Error('membership removal failed');
    const remove = jest
      .spyOn(db.manager.getRepository(AssetGroupAsset), 'remove')
      .mockImplementation(async () => {
        expect(
          await db.manager.query(
            'SELECT id FROM project_scope_rules WHERE "projectId"=$1 AND mode=$2',
            [project, 'exclude'],
          ),
        ).toHaveLength(1);
        throw failure;
      });
    try {
      await expect(
        service(db.manager).removeManyAssets(project, [asset], workspace),
      ).rejects.toBe(failure);
      expect(
        await db.manager.query(
          'SELECT id FROM project_scope_rules WHERE "projectId"=$1 AND mode=$2',
          [project, 'exclude'],
        ),
      ).toEqual([]);
      await db.commitTransaction();
      expect(await members()).toEqual([{ assetId: asset }]);
      expect(await rules()).toEqual([
        { mode: 'include', type: 'asset', value: asset },
      ]);
    } finally {
      remove.mockRestore();
      if (db.isTransactionActive) await db.rollbackTransaction();
      await db.release();
    }
  });

  it('waits for an in-flight scope addition before validating and durably removing its membership', async () => {
    const first = ds.createQueryRunner(),
      second = ds.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      await lockProjectScope(first.manager, project, workspace);
      await first.query(
        'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
        [project, 'include', 'asset', asset],
      );
      expect(await syncProjectScope(first.manager, project, workspace)).toEqual(
        { added: [asset], removed: 0 },
      );
      const [{ pid }] = await second.manager.query<{ pid: number }[]>(
        'SELECT pg_backend_pid() AS pid',
      );
      pending = service(second.manager)
        .removeManyAssets(project, [asset], workspace)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const [state] = await ds.query<{ waiting: boolean }[]>(
          'SELECT wait_event_type=$1 AS waiting FROM pg_stat_activity WHERE pid=$2',
          ['Lock', pid],
        );
        if (state?.waiting) {
          blocked = true;
          break;
        }
        await delay(5);
      }
      expect(blocked).toBe(true);
      await first.commitTransaction();
      expect(await pending).toEqual({
        value: {
          message: `1 assets successfully removed from asset group "${project}"`,
        },
      });
      await second.commitTransaction();
      expect(await members()).toEqual([]);
      expect(await rules()).toEqual([
        { mode: 'exclude', type: 'asset', value: asset },
        { mode: 'include', type: 'asset', value: asset },
      ]);
      expect(
        await ds.transaction((manager) =>
          syncProjectScope(manager, project, workspace),
        ),
      ).toEqual({ added: [], removed: 0 });
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      await pending;
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release();
      await second.release();
    }
  });

  it('retains trusted removal of historical projects without a workspace while rejecting scoped callers', async () => {
    const db = ds.createQueryRunner();
    await db.connect();
    await db.startTransaction();
    try {
      const [orphan] = await db.manager.query<{ id: string }[]>(
        'INSERT INTO projects (name) VALUES ($1) RETURNING id',
        [randomUUID()],
      );
      await db.query(
        'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',
        [orphan.id, asset],
      );
      await expect(
        service(db.manager).removeManyAssets(orphan.id, [asset], workspace),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await service(db.manager).removeManyAssets(orphan.id, [asset]),
      ).toEqual({
        message: `1 assets successfully removed from asset group "${orphan.id}"`,
      });
      expect(
        await db.manager.query(
          'SELECT id FROM project_assets WHERE "projectId"=$1',
          [orphan.id],
        ),
      ).toEqual([]);
    } finally {
      if (db.isTransactionActive) await db.rollbackTransaction();
      await db.release();
    }
  });
});
