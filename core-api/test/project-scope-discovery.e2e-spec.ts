import { dataSourceOptions } from '@/database/database-config';
import { ProjectScopeDiscoveryService } from '@/modules/projects/project-scope-discovery.service';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Project discovery attachment (e2e)', () => {
  let ds: DataSource, service: ProjectScopeDiscoveryService, owner: string;
  const workspaces: string[] = [],
    projects: string[] = [];
  const assets: Record<string, string> = {};
  const insert = async (sql: string, values: unknown[]) =>
    (await ds.query<{ id: string }[]>(sql + ' RETURNING id', values))[0].id;
  const members = () =>
    ds.query<
      {
        projectId: string;
        assetId: string;
        source: string;
        scopeRuleId: string | null;
      }[]
    >(
      'SELECT "projectId","assetId",source,"scopeRuleId" FROM project_assets WHERE "projectId"=ANY($1::uuid[]) ORDER BY "projectId","assetId"',
      [projects],
    );
  beforeAll(async () => {
    ds = new DataSource({
      ...dataSourceOptions,
      migrationsRun: false,
      cache: false,
      logging: false,
    });
    await ds.initialize();
    service = new ProjectScopeDiscoveryService(ds);
    owner = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus discovery', randomUUID() + '@example.test'],
    );
    for (let i = 0; i < 2; i++) {
      const ws = await insert(
        'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
        [randomUUID(), owner],
      );
      workspaces.push(ws);
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['scope.argus.test', 'DOMAIN', ws],
      );
      for (const key of i === 0
        ? ['api', 'mail', 'skip', 'manual']
        : ['foreign']) {
        assets[key] = await insert(
          'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
          [key + '.argus.test', target],
        );
      }
      for (let j = 0; j < (i === 0 ? 3 : 1); j++) {
        projects.push(
          await insert(
            'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
            [randomUUID(), ws],
          ),
        );
      }
    }
  });
  beforeEach(async () => {
    await ds.query(
      'DELETE FROM project_assets WHERE "projectId"=ANY($1::uuid[])',
      [projects],
    );
    await ds.query(
      'DELETE FROM project_scope_rules WHERE "projectId"=ANY($1::uuid[])',
      [projects],
    );
    await ds.query(
      'UPDATE projects SET "autoAddAssets"=true,"archivedAt"=NULL WHERE id=ANY($1::uuid[])',
      [projects],
    );
    for (const id of projects) {
      await insert(
        'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
        [id, 'include', 'hostname', '*.argus.test'],
      );
      await insert(
        'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
        [id, 'exclude', 'asset', assets.skip],
      );
    }
    await ds.query('UPDATE projects SET "autoAddAssets"=false WHERE id=$1', [
      projects[1],
    ]);
    await ds.query('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [
      projects[2],
    ]);
    await insert(
      'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',
      [projects[0], assets.manual],
    );
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await cleanupE2eData(ds, {
        workspaceIds: workspaces,
        userIds: [owner].filter(Boolean),
      });
      await ds.destroy();
    }
  });
  it('adds only supplied, owned matches to active opted-in projects and preserves manual provenance', async () => {
    const result = await service.addDiscoveredAssets(workspaces[0], [
      assets.api,
      assets.api,
      assets.skip,
      assets.manual,
      assets.foreign,
      randomUUID(),
    ]);
    expect([...result]).toEqual([[projects[0], [assets.api]]]);
    const rows = await members();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.assetId === assets.manual)).toMatchObject({
      source: 'manual',
      scopeRuleId: null,
    });
    const rule = (
      await ds.query<{ id: string }[]>(
        'SELECT id FROM project_scope_rules WHERE "projectId"=$1 AND mode=$2',
        [projects[0], 'include'],
      )
    )[0];
    expect(rows.find((r) => r.assetId === assets.api)).toMatchObject({
      projectId: projects[0],
      source: 'rule',
      scopeRuleId: rule.id,
    });
    expect(
      await service.addDiscoveredAssets(workspaces[0], [assets.api]),
    ).toEqual(new Map());
  });
  it('handles no candidates and exclusion-only projects without adding other workspace matches', async () => {
    expect(await service.addDiscoveredAssets(workspaces[0], [])).toEqual(
      new Map(),
    );
    await ds.query(
      'DELETE FROM project_scope_rules WHERE "projectId"=$1 AND mode=$2',
      [projects[0], 'include'],
    );
    expect(
      await service.addDiscoveredAssets(workspaces[0], [assets.mail]),
    ).toEqual(new Map());
    expect([
      ...(await service.addDiscoveredAssets(workspaces[1], [
        assets.api,
        assets.foreign,
      ])),
    ]).toEqual([[projects[3], [assets.foreign]]]);
  });
  it('serializes repeated concurrent batches without duplicates or reporting existing assets', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.addDiscoveredAssets(workspaces[0], [assets.api, assets.mail]),
      ),
    );
    const reported = results.flatMap((r) => [...r.values()].flat()).sort();
    expect(reported).toEqual([assets.api, assets.mail].sort());
    expect(await members()).toHaveLength(3);
  });
  it('rolls back every project insertion if any project fails', async () => {
    await ds.query('UPDATE projects SET "autoAddAssets"=true WHERE id=$1', [
      projects[1],
    ]);
    const before = await members(),
      error = new Error('injected second project failure');
    const failing = new ProjectScopeDiscoveryService({
      transaction: (
        run: (manager: EntityManager) => Promise<Map<string, string[]>>,
      ) =>
        ds.transaction(async (manager) => {
          const query = manager.query.bind(manager) as EntityManager['query'];
          let writes = 0;
          manager.query = <T>(sql: string, values?: unknown[]): Promise<T> => {
            if (sql.includes('INSERT INTO project_assets') && ++writes === 2)
              return Promise.reject(error);
            return query<T>(sql, values);
          };
          return run(manager);
        }),
    } as never);
    await expect(
      failing.addDiscoveredAssets(workspaces[0], [assets.api]),
    ).rejects.toBe(error);
    expect(await members()).toEqual(before);
  });
  it('waits for a concurrent preference change and rechecks eligibility after acquiring the project lock', async () => {
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        'UPDATE projects SET "autoAddAssets"=false WHERE id=$1',
        [projects[0]],
      );
      let backend = 0;
      const observed = new ProjectScopeDiscoveryService({
        transaction: (
          run: (manager: EntityManager) => Promise<Map<string, string[]>>,
        ) =>
          ds.transaction(async (manager) => {
            backend = (
              await manager.query<{ pid: number }[]>(
                'SELECT pg_backend_pid() AS pid',
              )
            )[0].pid;
            return run(manager);
          }),
      } as never);
      const pending = observed.addDiscoveredAssets(workspaces[0], [assets.api]);
      let locked = false;
      for (let i = 0; i < 200 && !locked; i++) {
        const rows = await ds.query<{ wait_event_type: string }[]>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
          [backend],
        );
        locked = rows[0]?.wait_event_type === 'Lock';
        if (!locked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await runner.commitTransaction();
      expect(await pending).toEqual(new Map());
      expect(locked).toBe(true);
      expect(await members()).toHaveLength(1);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
