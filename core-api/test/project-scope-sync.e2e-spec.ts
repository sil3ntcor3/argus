import { dataSourceOptions } from '@/database/database-config';
import {
  lockProjectScope,
  syncProjectScope,
} from '@/modules/projects/project-scope-sync';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Transactional project scope synchronization (e2e)', () => {
  let ds: DataSource;
  let owner: string,
    workspace: string,
    other: string,
    project: string,
    foreign: string;
  const assets: Record<string, string> = {};
  const insert = async (sql: string, args: unknown[]) =>
    (await ds.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
  const rule = (type: string, value: string, mode = 'include') =>
    insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value,"createdAt") VALUES ($1,$2,$3,$4,$5)',
      [project, mode, type, value, '2026-11-06T00:00:00Z'],
    );
  const member = (
    asset: string,
    source = 'rule',
    scopeRuleId: string | null = null,
  ) =>
    insert(
      'INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId") VALUES ($1,$2,$3,$4)',
      [project, asset, source, scopeRuleId],
    );
  const rows = () =>
    ds.query<{ assetId: string; source: string; scopeRuleId: string | null }[]>(
      'SELECT "assetId",source,"scopeRuleId" FROM project_assets WHERE "projectId"=$1 ORDER BY "assetId"',
      [project],
    );
  const sync = () =>
    ds.transaction((manager) => syncProjectScope(manager, project, workspace));
  beforeAll(async () => {
    ds = new DataSource({
      ...dataSourceOptions,
      migrationsRun: false,
      cache: false,
      logging: false,
    });
    await ds.initialize();
    owner = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus scope sync', randomUUID() + '@example.test'],
    );
    for (let i = 0; i < 2; i++) {
      const ws = await insert(
        'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
        [randomUUID(), owner],
      );
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['scope.argus.test', 'DOMAIN', ws],
      );
      const p = await insert(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
        [randomUUID(), ws],
      );
      if (i === 0) {
        workspace = ws;
        project = p;
      } else {
        other = ws;
        foreign = p;
      }
      for (const key of i === 0
        ? ['api', 'mail', 'manual', 'stale']
        : ['foreign']) {
        assets[key] = await insert(
          'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
          [
            key === 'stale' ? 'stale.example.test' : key + '.argus.test',
            target,
          ],
        );
      }
    }
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
        workspaceIds: [workspace, other].filter(Boolean),
        userIds: [owner].filter(Boolean),
      });
      await ds.destroy();
    }
  });
  it('adds desired members, removes obsolete rule rows and repoints first-match provenance without touching manual rows', async () => {
    const hostname = await rule('hostname', '*.argus.test');
    const exact = await rule('asset', assets.api);
    await rule('hostname', 'manual.argus.test', 'exclude');
    await rule('asset', assets.foreign);
    await member(assets.api);
    await member(assets.stale);
    await member(assets.foreign);
    await member(assets.manual, 'manual');
    const result = await sync();
    expect(result).toEqual({ added: [assets.mail], removed: 2 });
    expect(await rows()).toEqual(
      [
        {
          assetId: assets.api,
          source: 'rule',
          scopeRuleId: [hostname, exact].sort()[0],
        },
        { assetId: assets.mail, source: 'rule', scopeRuleId: hostname },
        { assetId: assets.manual, source: 'manual', scopeRuleId: null },
      ].sort((a, b) => a.assetId.localeCompare(b.assetId)),
    );
    expect(await sync()).toEqual({ added: [], removed: 0 });
  });
  it.each([false, true])(
    'removes only rule memberships when no include selects assets (exclusion=%s)',
    async (exclusion) => {
      if (exclusion) await rule('hostname', '*.argus.test', 'exclude');
      await member(assets.api);
      await member(assets.mail);
      await member(assets.manual, 'manual');
      expect(await sync()).toEqual({ added: [], removed: 2 });
      expect(await rows()).toEqual([
        { assetId: assets.manual, source: 'manual', scopeRuleId: null },
      ]);
    },
  );
  it('rejects a missing or foreign project before changing any memberships', async () => {
    await member(assets.api);
    const before = await rows();
    for (const [id, ws] of [
      [project, other],
      [foreign, workspace],
      [randomUUID(), workspace],
    ]) {
      await expect(
        ds.transaction((manager) => syncProjectScope(manager, id, ws)),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await rows()).toEqual(before);
  });
  it('rolls back additions, deletions and provenance updates when the caller fails', async () => {
    await rule('hostname', '*.argus.test');
    await member(assets.api);
    await member(assets.stale);
    const before = await rows();
    await expect(
      ds.transaction(async (manager) => {
        await syncProjectScope(manager, project, workspace);
        throw new Error('rollback scope sync');
      }),
    ).rejects.toThrow('rollback scope sync');
    expect(await rows()).toEqual(before);
  });
  it('serializes competing syncs and uses resolved UUIDs without duplicate additions', async () => {
    await rule('hostname', '*.argus.test');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ds.transaction((manager) =>
          syncProjectScope(manager, project.toUpperCase(), workspace),
        ),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.added.length, 0)).toBe(
      3,
    );
    expect(results.reduce((sum, result) => sum + result.removed, 0)).toBe(0);
    expect((await rows()).map((row) => row.assetId).sort()).toEqual(
      [assets.api, assets.mail, assets.manual].sort(),
    );
  });
  it('requires an active transaction before accessing or mutating persistence', async () => {
    await expect(
      syncProjectScope(ds.manager, project, workspace),
    ).rejects.toThrow('active transaction');
  });
  it('waits for the project lock and then reads the newly committed rules', async () => {
    await rule('hostname', '*.argus.test');
    const first = ds.createQueryRunner(),
      second = ds.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();
    let pending: ReturnType<typeof syncProjectScope> | undefined;
    try {
      await lockProjectScope(first.manager, project, workspace);
      const [{ pid }] = await second.query<{ pid: number }[]>(
        'SELECT pg_backend_pid() AS pid',
      );
      pending = syncProjectScope(second.manager, project, workspace);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await ds.query<{ waiting: boolean }[]>(
          'SELECT wait_event_type = $1 AS waiting FROM pg_stat_activity WHERE pid = $2',
          ['Lock', pid],
        );
        if (state?.waiting) {
          blocked = true;
          break;
        }
        await delay(5);
      }
      expect(blocked).toBe(true);
      await first.query(
        'DELETE FROM project_scope_rules WHERE "projectId"=$1',
        [project],
      );
      await first.query(
        'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
        [project, 'include', 'asset', assets.api],
      );
      await first.commitTransaction();
      expect(await pending).toEqual({ added: [assets.api], removed: 0 });
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      await pending?.catch(() => undefined);
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release();
      await second.release();
    }
  });
});
