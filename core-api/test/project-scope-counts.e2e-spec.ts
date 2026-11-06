import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { dataSourceOptions } from '@/database/database-config';
import { countScopeRules } from '@/modules/projects/project-scope-preview.service';
import { ProjectScopeReadService } from '@/modules/projects/project-scope-read.service';
import type { ScopeRuleLike } from '@/modules/projects/scope-rules';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

describe('Bounded saved scope match counts (e2e)', () => {
  let ds: DataSource, db: QueryRunner, counter: jest.SpyInstance;
  let workspace: string,
    project: string,
    api: string,
    manual: string,
    foreign: string,
    outside: string;
  const include: ScopeRuleLike = {
    mode: Mode.INCLUDE,
    type: Kind.HOSTNAME,
    value: '*.argus.test',
  };
  const exclude = (value: string): ScopeRuleLike => ({
    mode: Mode.EXCLUDE,
    type: Kind.ASSET,
    value,
  });
  const insert = async (sql: string, args: unknown[]) =>
    (await db.manager.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
  beforeAll(async () => {
    ds = new DataSource({
      ...dataSourceOptions,
      migrationsRun: false,
      cache: false,
      logging: false,
    });
    await ds.initialize();
    db = ds.createQueryRunner();
    await db.connect();
    await db.startTransaction();
    const user = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus scope counts', randomUUID() + '@example.test'],
    );
    for (let i = 0; i < 2; i++) {
      const ws = await insert(
        'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
        [randomUUID(), user],
      );
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['scope.argus.test', 'DOMAIN', ws],
      );
      const asset = await insert(
        'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
        [i ? 'secret.other.argus.test' : 'api.argus.test', target],
      );
      if (i === 0) {
        workspace = ws;
        api = asset;
        manual = await insert(
          'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
          ['manual.argus.test', target],
        );
        outside = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', ['outside.example.test', target]);
        project = await insert(
          'INSERT INTO projects (name,"workspaceId","autoAddAssets") VALUES ($1,$2,false)',
          [randomUUID(), ws],
        );
      } else foreign = asset;
    }
  });
  beforeEach(async () => {
    await db.query('SAVEPOINT count_case');
    counter = jest.spyOn(db, 'query');
  });
  afterEach(async () => {
    counter?.mockRestore();
    await db.query('ROLLBACK TO SAVEPOINT count_case');
  });
  afterAll(async () => {
    if (db?.isTransactionActive) await db.rollbackTransaction();
    await db?.release();
    if (ds?.isInitialized) await ds.destroy();
  });
  it('counts owned matches per original row without applying other exclusions or exposing foreign assets', async () => {
    const rules = [
      include,
      exclude(api),
      { mode: Mode.EXCLUDE, type: Kind.HOSTNAME, value: 'manual.argus.test' },
      exclude(api.toUpperCase()),
      exclude(foreign),
      exclude(randomUUID()),
      exclude(outside),
    ];
    expect(await countScopeRules(db.manager, workspace, rules)).toEqual([
      2, 1, 1, 1, 0, 0, 0,
    ]);
    expect(counter.mock.calls.length).toBe(3);
  });
  it('does not query for empty or exclusion-only scopes', async () => {
    expect(await countScopeRules(db.manager, workspace, [])).toEqual([]);
    expect(
      await countScopeRules(db.manager, workspace, [
        exclude(api),
        exclude(foreign),
      ]),
    ).toEqual([0, 0]);
    expect(counter).not.toHaveBeenCalled();
  });
  it('preserves scalar counting for one asset exclusion', async () => {
    expect(
      await countScopeRules(db.manager, workspace, [include, exclude(api)]),
    ).toEqual([2, 1]);
    expect(counter.mock.calls.length).toBe(2);
  });
  it('reads 65,536 stored asset exclusions with bounded queries and private tenant-safe labels/counts', async () => {
    for (const [mode, type, value] of [
      ['include', 'hostname', '*.argus.test'],
      ['exclude', 'asset', api],
      ['exclude', 'asset', foreign],
    ])
      await insert(
        'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
        [project, mode, type, value],
      );
    await db.query(
      `INSERT INTO project_scope_rules ("projectId",mode,type,value)
      SELECT $1,'exclude','asset',gen_random_uuid()::text FROM generate_series(1,65534)`,
      [project],
    );
    for (const [asset, source] of [
      [api, 'manual'],
      [manual, 'rule'],
    ])
      await insert(
        'INSERT INTO project_assets ("projectId","assetId",source) VALUES ($1,$2,$3)',
        [project, asset, source],
      );
    counter.mockClear();
    const scope = await new ProjectScopeReadService(
      db.manager as never,
    ).getScope(project, workspace);
    expect(counter.mock.calls.length).toBeLessThanOrEqual(8);
    expect(scope).toMatchObject({
      autoAddAssets: false,
      manualAssets: 1,
      ruleAssets: 1,
    });
    expect(scope.rules.length).toBe(65_537);
    expect(scope.rules.find((row) => row.value === api)).toMatchObject({
      label: 'api.argus.test',
      matched: 1,
    });
    expect(scope.rules.find((row) => row.value === foreign)).toMatchObject({
      label: foreign,
      matched: 0,
    });
    expect(
      scope.rules
        .filter((row) => row.mode === Mode.EXCLUDE && row.matched)
        .map((row) => row.value),
    ).toEqual([api]);
    expect(scope.rules.reduce((sum, row) => sum + row.matched, 0)).toBe(3);
    expect(JSON.stringify(scope)).not.toContain('secret.other.argus.test');
  });
});
