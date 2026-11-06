import { dataSourceOptions } from '@/database/database-config';
import { AssetGroupAsset } from '@/modules/asset-group/entities/asset-groups-assets.entity';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

describe('Project scope provenance index (e2e)', () => {
  let ds: DataSource, db: QueryRunner;
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
  });
  afterAll(async () => {
    if (db?.isTransactionActive) await db.rollbackTransaction();
    await db?.release();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('indexes the nullable rule reference with a valid nonunique B-tree in PostgreSQL and ORM metadata', async () => {
    const rows = await db.manager.query<Record<string, unknown>[]>(
      `SELECT i.indisvalid, i.indisready, i.indisunique, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
       JOIN pg_namespace ns ON ns.oid=idx.relnamespace
       WHERE ns.nspname='public' AND idx.relname=$1`,
      ['IDX_pa_scopeRuleId'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      indisvalid: true,
      indisready: true,
      indisunique: false,
    });
    expect(rows[0].definition).toBe(
      'CREATE INDEX "IDX_pa_scopeRuleId" ON public.project_assets USING btree ("scopeRuleId")',
    );
    const index = ds
      .getMetadata(AssetGroupAsset)
      .indices.find((row) => row.name === 'IDX_pa_scopeRuleId');
    expect(index?.columns.map((column) => column.databaseName)).toEqual([
      'scopeRuleId',
    ]);
    expect(index?.isUnique).toBe(false);
  });

  it('cleans up 65,536 saved rules without deleting assets or memberships', async () => {
    expect(
      await db.manager.query('SELECT to_regclass($1)::text AS name', [
        'public."IDX_pa_scopeRuleId"',
      ]),
    ).toEqual([{ name: '"IDX_pa_scopeRuleId"' }]);
    const insert = async (sql: string, values: unknown[]) =>
      (
        await db.manager.query<{ id: string }[]>(sql + ' RETURNING id', values)
      )[0].id;
    const user = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus index regression', randomUUID() + '@example.test'],
    );
    const workspace = await insert(
      'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
      [randomUUID(), user],
    );
    const project = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), workspace],
    );
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['index.argus.test', 'DOMAIN', workspace],
    );
    const rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'hostname', '*.argus.test'],
    );
    await db.query(
      `INSERT INTO assets (value,"targetId") SELECT 'index-' || n || '.argus.test',$1 FROM generate_series(1,65536) n`,
      [target],
    );
    await db.query(
      `INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId")
      SELECT $1,id,CASE WHEN value='index-1.argus.test' THEN 'manual' ELSE 'rule' END,$2 FROM assets WHERE "targetId"=$3`,
      [project, rule, target],
    );
    await db.query(
      `INSERT INTO project_scope_rules ("projectId",mode,type,value)
      SELECT $1,'exclude','asset',gen_random_uuid()::text FROM generate_series(1,65535)`,
      [project],
    );
    const deleted: [unknown[], number] = await db.query(
      'DELETE FROM project_scope_rules WHERE "projectId"=$1',
      [project],
    );
    expect(deleted[1]).toBe(65_536);
    expect(
      await db.manager.query(
        `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE "scopeRuleId" IS NULL)::int AS cleared,
      count(*) FILTER (WHERE source='manual')::int AS manual,
      count(*) FILTER (WHERE source='rule')::int AS rule FROM project_assets WHERE "projectId"=$1`,
        [project],
      ),
    ).toEqual([{ total: 65_536, cleared: 65_536, manual: 1, rule: 65_535 }]);
    expect(
      await db.manager.query(
        'SELECT count(*)::int AS total FROM assets WHERE "targetId"=$1',
        [target],
      ),
    ).toEqual([{ total: 65_536 }]);
  });
});
