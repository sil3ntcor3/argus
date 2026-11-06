import { dataSourceOptions } from '@/database/database-config';
import { ProjectScopeReadService } from '@/modules/projects/project-scope-read.service';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

describe('Scoped project rule read model (e2e)', () => {
  let ds: DataSource, db: QueryRunner, service: ProjectScopeReadService;
  let workspace: string, project: string, empty: string, foreignProject: string;
  const rules: Record<string, string> = {};
  const values: Record<string, string> = {};
  const insert = async (sql: string, args: unknown[]) =>
    (await db.manager.query<{ id: string }[]>(sql + ' RETURNING id', args))[0]
      .id;
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
    service = new ProjectScopeReadService(db.manager as never);
    const owner = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus scope reads', randomUUID() + '@example.test'],
    );
    workspace = await insert(
      'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
      [randomUUID(), owner],
    );
    const other = await insert(
      'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
      [randomUUID(), owner],
    );
    project = await insert(
      'INSERT INTO projects (name,"workspaceId","autoAddAssets") VALUES ($1,$2,false)',
      [randomUUID(), workspace],
    );
    empty = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), workspace],
    );
    foreignProject = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), other],
    );
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['scope.argus.test', 'DOMAIN', workspace],
    );
    // Independent tables can share UUIDs; target and asset labels must not collide.
    const asset = await insert(
      'INSERT INTO assets (id,value,"targetId") VALUES ($1,$2,$3)',
      [target, 'api.argus.test', target],
    );
    const manual = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['manual.argus.test', target],
    );
    const foreignTarget = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['secret.other.test', 'DOMAIN', other],
    );
    const foreignAsset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['hidden.secret.other.test', foreignTarget],
    );
    for (const [name, mode, type, value] of [
      ['target', 'include', 'target', target.toUpperCase()],
      ['asset', 'include', 'asset', asset],
      ['exclude', 'exclude', 'hostname', 'manual.argus.test'],
      ['foreignTarget', 'include', 'target', foreignTarget],
      ['foreignAsset', 'include', 'asset', foreignAsset],
    ]) {
      rules[name] = await insert(
        'INSERT INTO project_scope_rules ("projectId",mode,type,value,"createdAt") VALUES ($1,$2,$3,$4,$5)',
        [project, mode, type, value, '2026-11-06T00:00:00Z'],
      );
      values[name] = value;
    }
    for (const [id, source] of [
      [asset, 'rule'],
      [manual, 'manual'],
      [foreignAsset, 'manual'],
    ])
      await insert(
        'INSERT INTO project_assets ("projectId","assetId",source) VALUES ($1,$2,$3)',
        [project, id, source],
      );
  });
  afterAll(async () => {
    if (db?.isTransactionActive) await db.rollbackTransaction();
    await db?.release();
    if (ds?.isInitialized) await ds.destroy();
  });
  it('loads private preferences and distinguishes target/asset labels sharing a UUID', async () => {
    const result = await service.getScope(project.toUpperCase(), workspace);
    expect(result).toMatchObject({
      autoAddAssets: false,
      ruleAssets: 1,
      manualAssets: 1,
    });
    expect(result.rules.find((rule) => rule.id === rules.target)).toMatchObject(
      { label: 'scope.argus.test', matched: 2, value: values.target },
    );
    expect(result.rules.find((rule) => rule.id === rules.asset)).toMatchObject({
      label: 'api.argus.test',
      matched: 1,
    });
    expect(
      result.rules.find((rule) => rule.id === rules.exclude),
    ).toMatchObject({ label: 'manual.argus.test', matched: 1 });
  });
  it('omits foreign labels, matches and malformed historical membership from counts', async () => {
    const result = await service.getScope(project, workspace);
    for (const key of ['foreignTarget', 'foreignAsset'])
      expect(result.rules.find((rule) => rule.id === rules[key])).toMatchObject(
        { label: values[key], matched: 0 },
      );
    expect(JSON.stringify(result)).not.toContain('secret.other.test');
    expect(result.manualAssets).toBe(1);
  });
  it('returns stable stored rule order without changing rules or membership', async () => {
    const before = await db.manager.query<object[]>(
      'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
      [project],
    );
    expect(
      (await service.getScope(project, workspace)).rules.map((rule) => rule.id),
    ).toEqual(Object.values(rules).sort());
    expect(
      await db.manager.query<object[]>(
        'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
        [project],
      ),
    ).toEqual(before);
  });
  it('returns defaults for projects without rules or members', async () => {
    expect(await service.getScope(empty, workspace)).toEqual({
      rules: [],
      autoAddAssets: true,
      ruleAssets: 0,
      manualAssets: 0,
    });
  });
  it.each([true, false])(
    'rejects foreign or nonexistent projects (exists=%s)',
    async (exists) => {
      await expect(
        service.getScope(exists ? foreignProject : randomUUID(), workspace),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );
});
