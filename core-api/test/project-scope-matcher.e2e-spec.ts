import { dataSourceOptions } from '@/database/database-config';
import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import {
  scopeRuleMatchSql,
  scopeRulesSql,
  SqlParams,
} from '@/modules/projects/scope-rules';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

describe('Bound project scope matching (e2e)', () => {
  let ds: DataSource, db: QueryRunner, workspace: string, target: string;
  const ids: Record<string, string> = {};
  const insert = async (sql: string, values: unknown[]) =>
    (await db.manager.query<{ id: string }[]>(sql + ' RETURNING id', values))[0].id;
  const query = async (type: Kind, value: string) => {
    const params = new SqlParams([workspace]);
    const where = scopeRuleMatchSql(
      { mode: Mode.INCLUDE, type, value },
      params,
    );
    return (
      await db.manager.query<{ id: string }[]>(
        `SELECT a.id FROM assets a JOIN targets t ON t.id=a."targetId" WHERE t."workspaceId"=$1 AND (${where})`,
        params.values,
      )
    )
      .map((row) => row.id)
      .sort();
  };
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
    const owner = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus scope SQL', randomUUID() + '@example.test'],
    );
    workspace = await insert(
      'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
      [randomUUID(), owner],
    );
    const other = await insert(
      'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
      [randomUUID(), owner],
    );
    target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['scope.argus.test', 'DOMAIN', workspace],
    );
    const foreignTarget = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
      ['other.argus.test', 'DOMAIN', other],
    );
    for (const [key, value] of Object.entries({
      raw: '192.0.2.20',
      dns: 'dns.argus.test',
      http: 'http.argus.test',
      resolver: 'resolver.argus.test',
      v6: '2001:db8::7',
      literal: 'api_1.argus.test',
      distractor: 'apiX1.argus.test',
    })) {
      ids[key] = await insert(
        'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
        [value, target],
      );
    }
    ids.foreign = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['foreign.argus.test', foreignTarget],
    );
    for (const key of ['dns', 'foreign'])
      await db.query(
        'INSERT INTO ip_observations ("assetId",ip,source) VALUES ($1,$2,$3)',
        [ids[key], '192.0.2.21', 'dns_a'],
      );
    for (const key of ['http', 'resolver']) {
      const service = await insert(
        'INSERT INTO asset_services (value,port,"assetId") VALUES ($1,443,$2)',
        [key + '.argus.test', ids[key]],
      );
      await db.query(
        'INSERT INTO ip_observations ("assetServiceId",ip,source) VALUES ($1,$2,$3)',
        [service, '192.0.2.22', key === 'http' ? 'httpx_a' : 'resolver'],
      );
    }
    // A legacy directly attributed resolver must not count as a host address.
    await db.query(
      'INSERT INTO ip_observations ("assetId",ip,source) VALUES ($1,$2,$3)',
      [ids.resolver, '192.0.2.23', 'resolver'],
    );
  });
  afterAll(async () => {
    if (db?.isTransactionActive) await db.rollbackTransaction();
    await db?.release();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('matches raw, DNS and HTTP addresses while excluding resolver and foreign-workspace observations', async () => {
    expect(await query(Kind.CIDR, '192.0.2.0/24')).toEqual(
      [ids.raw, ids.dns, ids.http].sort(),
    );
    expect(await query(Kind.ASSET, ids.foreign)).toEqual([]);
  });
  it('handles IPv6 and safely evaluates hostname values behind the inet cast guard', async () => {
    expect(await query(Kind.CIDR, '2001:db8::/32')).toEqual([ids.v6]);
  });
  it('escapes literal underscores and binds injection-shaped values', async () => {
    expect(await query(Kind.HOSTNAME, 'api_*.argus.test')).toEqual([
      ids.literal,
    ]);
    expect(await query(Kind.HOSTNAME, "x%' OR true --")).toEqual([]);
  });
  it('combines exclusions and stable lazy rule ids in executable SQL', async () => {
    const first = randomUUID(),
      second = randomUUID(),
      params = new SqlParams([workspace]);
    const built = scopeRulesSql(
      [
        { id: first, mode: Mode.INCLUDE, type: Kind.HOSTNAME, value: 'dns.*' },
        { id: second, mode: Mode.INCLUDE, type: Kind.TARGET, value: target },
        { mode: Mode.EXCLUDE, type: Kind.ASSET, value: ids.http },
      ],
      params,
    )!;
    const ruleId = built.ruleIdSql();
    expect(built.ruleIdSql()).toBe(ruleId);
    const rows = await db.manager.query<{ id: string; ruleId: string }[]>(
      `SELECT a.id,${ruleId} AS "ruleId" FROM assets a JOIN targets t ON t.id=a."targetId" WHERE t."workspaceId"=$1 AND ${built.where}`,
      params.values,
    );
    expect(rows.map((row) => row.id).sort()).toEqual(
      Object.entries(ids)
        .filter(([key]) => !['foreign', 'http'].includes(key))
        .map(([, id]) => id)
        .sort(),
    );
    for (const row of rows)
      expect(row.ruleId).toBe(row.id === ids.dns ? first : second);
  });
});
