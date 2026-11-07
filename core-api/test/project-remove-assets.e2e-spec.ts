import { dataSourceOptions } from '@/database/database-config';
import { ProjectAssetsService } from '@/modules/projects/project-assets.service';
import { syncProjectScope } from '@/modules/projects/project-scope-sync';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Canonical project membership removal (e2e)', () => {
  let ds: DataSource,
    service: ProjectAssetsService,
    user: string,
    workspace: string,
    other: string,
    project: string,
    foreign: string;
  const assets: string[] = [];
  const insert = async (sql: string, args: unknown[]) =>
    (await ds.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
  const members = () =>
    ds.query<{ assetId: string; source: string; scopeRuleId: string | null }[]>(
      'SELECT "assetId",source,"scopeRuleId" FROM project_assets WHERE "projectId"=$1 ORDER BY "assetId"',
      [project],
    );
  const rules = () =>
    ds.query<{ mode: string; type: string; value: string }[]>(
      'SELECT mode,type,value FROM project_scope_rules WHERE "projectId"=$1 ORDER BY mode,type,value',
      [project],
    );
  beforeAll(async () => {
    ds = new DataSource({
      ...dataSourceOptions,
      migrationsRun: false,
      cache: false,
      logging: false,
    });
    await ds.initialize();
    service = new ProjectAssetsService(ds);
    user = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus canonical removal', randomUUID() + '@example.test'],
    );
    for (let i = 0; i < 2; i++) {
      const ws = await insert(
        'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
        [randomUUID(), user],
      );
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['remove.argus.test', 'DOMAIN', ws],
      );
      const id = await insert(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
        [randomUUID(), ws],
      );
      if (i === 0) {
        workspace = ws;
        project = id;
      } else {
        other = ws;
        foreign = id;
      }
      for (const name of i === 0 ? ['keep', 'rule', 'manual'] : ['foreign'])
        assets.push(
          await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
            name + '.argus.test',
            target,
          ]),
        );
    }
  });
  beforeEach(async () => {
    await ds.query('DELETE FROM project_assets WHERE "projectId"=$1', [
      project,
    ]);
    await ds.query('DELETE FROM project_scope_rules WHERE "projectId"=$1', [
      project,
    ]);
    const rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'hostname', '*.argus.test'],
    );
    for (let i = 0; i < 3; i++)
      await ds.query(
        'INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId") VALUES ($1,$2,$3,$4)',
        [
          project,
          assets[i],
          i === 2 ? 'manual' : 'rule',
          i === 2 ? null : rule,
        ],
      );
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await cleanupE2eData(ds, {
        workspaceIds: [workspace, other].filter(Boolean),
        userIds: [user].filter(Boolean),
      });
      await ds.destroy();
    }
  });
  it('removes selected manual/rule memberships once and durably excludes them without deleting assets', async () => {
    const input = [assets[1], ' ' + assets[1].toUpperCase() + ' ', assets[2]];
    expect(await service.remove(project.toUpperCase(), workspace, input)).toBe(
      2,
    );
    expect((await members()).map((row) => row.assetId)).toEqual([assets[0]]);
    const excluded = (await rules()).filter((row) => row.mode === 'exclude');
    expect(excluded.map((row) => row.value).sort()).toEqual(
      [assets[1], assets[2]].sort(),
    );
    expect(excluded.every((row) => row.type === 'asset')).toBe(true);
    expect(
      await service.remove(project, workspace, [...input, randomUUID()]),
    ).toBe(0);
    expect((await rules()).filter((row) => row.mode === 'exclude')).toEqual(
      excluded,
    );
    expect(
      await ds.transaction((manager) =>
        syncProjectScope(manager, project, workspace),
      ),
    ).toEqual({ added: [], removed: 0 });
    expect((await members()).map((row) => row.assetId)).toEqual([assets[0]]);
    expect(
      (
        await ds.query('SELECT id FROM assets WHERE id=ANY($1::uuid[])', [
          assets,
        ])
      ).length,
    ).toBe(4);
  });
  it('ignores foreign candidates even when a historical cross-workspace membership exists', async () => {
    await ds.query(
      'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',
      [project, assets[3]],
    );
    const before = await members(),
      savedRules = await rules();
    expect(
      await service.remove(project, workspace, [assets[3], randomUUID()]),
    ).toBe(0);
    expect(await members()).toEqual(before);
    expect(await rules()).toEqual(savedRules);
    expect(
      await service.remove(project, workspace, [assets[1], assets[3]]),
    ).toBe(1);
    expect((await members()).some((row) => row.assetId === assets[3])).toBe(
      true,
    );
    expect(
      (await rules())
        .filter((row) => row.mode === 'exclude')
        .map((row) => row.value),
    ).toEqual([assets[1]]);
  });
  it('validates candidates and authorizes empty requests without altering rules or membership', async () => {
    const before = await members(),
      savedRules = await rules();
    for (const ids of [null, {}, ['invalid'], [null], [42]])
      await expect(
        service.remove(project, workspace, ids as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    for (const [id, ws] of [
      [foreign, workspace],
      [project, other],
      [randomUUID(), workspace],
    ])
      await expect(service.remove(id, ws, [])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    expect(await service.remove(project, workspace, [])).toBe(0);
    expect(await members()).toEqual(before);
    expect(await rules()).toEqual(savedRules);
  });
  it.each(['delete', 'commit'])(
    'rolls back new exclusions and membership deletion when %s fails',
    async (stage) => {
      const before = await members(),
        savedRules = await rules(),
        failure = new Error('canonical removal failed');
      const failing = new ProjectAssetsService({
        transaction: (run: (manager: EntityManager) => Promise<unknown>) =>
          ds.transaction(async (manager) => {
            const query = manager.query.bind(manager) as EntityManager['query'];
            manager.query = <T>(sql: string, args?: unknown[]): Promise<T> =>
              stage === 'delete' && sql.includes('DELETE FROM project_assets')
                ? Promise.reject(failure)
                : query<T>(sql, args);
            const result = await run(manager);
            if (stage === 'commit') throw failure;
            return result;
          }),
      } as unknown as DataSource);
      await expect(
        failing.remove(project, workspace, [assets[1], assets[2]]),
      ).rejects.toBe(failure);
      expect(await members()).toEqual(before);
      expect(await rules()).toEqual(savedRules);
    },
  );
  it('serializes competing removals and creates only one exact exclusion', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.remove(project, workspace, [assets[1]]),
      ),
    );
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await rules()).filter((row) => row.mode === 'exclude')).toEqual([
      { mode: 'exclude', type: 'asset', value: assets[1] },
    ]);
    expect(
      await ds.transaction((manager) =>
        syncProjectScope(manager, project, workspace),
      ),
    ).toEqual({ added: [], removed: 0 });
    expect((await members()).some((row) => row.assetId === assets[1])).toBe(
      false,
    );
  });
});
