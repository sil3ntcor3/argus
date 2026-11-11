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
import { DataSource } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Legacy project additions and scope synchronization (e2e)', () => {
  let ds: DataSource,
    user: string,
    workspace: string,
    project: string,
    asset: string;
  beforeAll(async () => {
    ds = new DataSource({
      ...dataSourceOptions,
      migrationsRun: false,
      cache: false,
      logging: false,
    });
    await ds.initialize();
    const insert = async (sql: string, args: unknown[]) =>
      (await ds.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
    user = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [
        randomUUID(),
        'Argus membership coordination',
        randomUUID() + '@example.test',
      ],
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
      ['membership.argus.test', 'DOMAIN', workspace],
    );
    asset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['membership.argus.test', target],
    );
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

  it('waits for a scope update before checking duplicates and then retains the manual addition', async () => {
    await ds.query(
      'INSERT INTO project_assets ("projectId","assetId",source) VALUES ($1,$2,$3)',
      [project, asset, 'rule'],
    );
    const first = ds.createQueryRunner(),
      second = ds.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      await lockProjectScope(first.manager, project, workspace);
      expect(await syncProjectScope(first.manager, project, workspace)).toEqual(
        { added: [], removed: 1 },
      );
      const service = new AssetGroupAssetService(
        second.manager.getRepository(AssetGroup),
        second.manager.getRepository(AssetGroupAsset),
        second.manager.getRepository(Asset),
      );
      const [{ pid }] = await second.manager.query<{ pid: number }[]>(
        'SELECT pg_backend_pid() AS pid',
      );
      pending = service
        .addManyAssets(project.toUpperCase(), [asset], workspace)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
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
          message: `1 assets successfully added to asset group "${project.toUpperCase()}"`,
        },
      });
      await second.commitTransaction();
      expect(
        await ds.query(
          'SELECT "assetId",source,"scopeRuleId" FROM project_assets WHERE "projectId"=$1',
          [project],
        ),
      ).toEqual([{ assetId: asset, source: 'manual', scopeRuleId: null }]);
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
});
