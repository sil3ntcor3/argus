import { excludeMatchedScopeAssets } from '@/modules/projects/project-scope-exclusions';
import { dataSourceOptions } from '@/database/database-config';
import { syncProjectScope } from '@/modules/projects/project-scope-sync';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Durable project scope exclusions (e2e)', () => {
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
      await ds.query('DELETE FROM project_assets WHERE "projectId"=$1', [
        project,
      ]);
      await ds.query('DELETE FROM projects WHERE id=$1', [project]);
      await cleanupE2eData(ds, {
        workspaceIds: [workspace, other].filter(Boolean),
        userIds: [owner].filter(Boolean),
      });
      await ds.destroy();
    }
  });
  const exclude = (ids: string[]) =>
    ds.transaction((manager) =>
      excludeMatchedScopeAssets(manager, project, workspace, ids),
    );
  const savedRules = () =>
    ds.query<{ mode: string; type: string; value: string }[]>(
      'SELECT mode,type,value FROM project_scope_rules WHERE "projectId"=$1 ORDER BY id',
      [project],
    );
  it('excludes only currently selected owned assets without changing membership or duplicating exclusions', async () => {
    await rule('hostname', '*.argus.test');
    await rule('asset', assets.mail, 'exclude');
    await member(assets.api);
    await member(assets.manual, 'manual');
    const before = await rows();
    const ids = [
      assets.api,
      assets.api.toUpperCase(),
      assets.manual,
      assets.mail,
      assets.foreign,
    ];
    expect(await exclude(ids)).toBe(2);
    expect(await rows()).toEqual(before);
    expect(
      (await savedRules())
        .filter((row) => row.type === 'asset' && row.mode === 'exclude')
        .map((row) => row.value)
        .sort(),
    ).toEqual([assets.api, assets.mail, assets.manual].sort());
    expect(await exclude(ids)).toBe(0);
    expect(await savedRules()).toHaveLength(4);
    expect(await sync()).toEqual({ added: [], removed: 1 });
    expect(await rows()).toEqual([
      { assetId: assets.manual, source: 'manual', scopeRuleId: null },
    ]);
  });
  it.each(['empty', 'exclude-only', 'no-assets'])(
    'leaves rules and membership unchanged for %s input',
    async (scenario) => {
      if (scenario !== 'empty')
        await rule(
          'hostname',
          '*.argus.test',
          scenario === 'exclude-only' ? 'exclude' : 'include',
        );
      await member(assets.api);
      const beforeRules = await savedRules(),
        beforeMembers = await rows();
      expect(await exclude(scenario === 'no-assets' ? [] : [assets.api])).toBe(
        0,
      );
      expect(await savedRules()).toEqual(beforeRules);
      expect(await rows()).toEqual(beforeMembers);
    },
  );
  it('refuses foreign or missing projects and never imports a foreign asset reference', async () => {
    await rule('hostname', '*.argus.test');
    for (const [id, ws] of [
      [project, other],
      [foreign, workspace],
      [randomUUID(), workspace],
    ]) {
      await expect(
        ds.transaction((manager) =>
          excludeMatchedScopeAssets(manager, id, ws, [assets.api]),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await exclude([assets.foreign, randomUUID()])).toBe(0);
    expect(await savedRules()).toHaveLength(1);
  });
  it('validates every candidate ID before inserting any exclusions', async () => {
    await rule('hostname', '*.argus.test');
    for (const ids of [null, [assets.api, 'invalid']])
      await expect(exclude(ids as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    expect(await savedRules()).toHaveLength(1);
  });
  it('participates in caller rollback and requires an active transaction', async () => {
    await rule('hostname', '*.argus.test');
    await expect(
      ds.transaction(async (manager) => {
        expect(
          await excludeMatchedScopeAssets(manager, project, workspace, [
            assets.api,
          ]),
        ).toBe(1);
        throw new Error('rollback exclusions');
      }),
    ).rejects.toThrow('rollback exclusions');
    expect(await savedRules()).toHaveLength(1);
    await expect(
      excludeMatchedScopeAssets(ds.manager, project, workspace, [assets.api]),
    ).rejects.toThrow('active transaction');
  });
  it('serializes eight competing requests into one exclusion without a new database constraint', async () => {
    await rule('hostname', '*.argus.test');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => exclude([assets.api])),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(
      (await savedRules()).filter((row) => row.mode === 'exclude'),
    ).toEqual([{ mode: 'exclude', type: 'asset', value: assets.api }]);
  });
  it('keeps a scope usable after excluding more than 65,535 matching assets', async () => {
    await rule('hostname', '*.argus.test');
    const [asset] = await ds.query<{ targetId: string }[]>(
      'SELECT "targetId" FROM assets WHERE id=$1',
      [assets.api],
    );
    const bulk = await ds.query<{ id: string }[]>(
      `INSERT INTO assets (value,"targetId")
       SELECT 'bulk-' || n || '.argus.test', $1 FROM generate_series(1,65536) n RETURNING id`,
      [asset.targetId],
    );
    const ids = bulk.map((row) => row.id);
    expect((await sync()).added.length).toBe(65_539);
    expect(await exclude(ids)).toBe(65_536);
    expect(await exclude(ids)).toBe(0);
    expect(await sync()).toEqual({ added: [], removed: 65_536 });
    expect((await rows()).map((row) => row.assetId).sort()).toEqual(
      [assets.api, assets.mail, assets.manual].sort(),
    );
    expect(await sync()).toEqual({ added: [], removed: 0 });
  });
});
