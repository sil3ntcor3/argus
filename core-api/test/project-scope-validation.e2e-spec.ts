import { dataSourceOptions } from '@/database/database-config';
import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { ProjectScopeNormalizer } from '@/modules/projects/project-scope-normalizer.service';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

describe('Workspace-aware project scope validation (e2e)', () => {
  let ds: DataSource, db: QueryRunner, service: ProjectScopeNormalizer;
  const workspaces: string[] = [],
    targets: string[] = [],
    assets: string[] = [];
  const insert = async (sql: string, values: unknown[]) =>
    (await db.manager.query<{ id: string }[]>(sql + ' RETURNING id', values))[0]
      .id;
  const rule = (type: Kind, value: string) => ({
    mode: Mode.INCLUDE,
    type,
    value,
  });

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
    // Execute the actual service SQL through the fixture's transaction runner.
    service = new ProjectScopeNormalizer({
      query: (sql: string, values: unknown[]) => db.query(sql, values),
    } as never);
    const owner = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus scope validation', randomUUID() + '@example.test'],
    );
    for (let i = 0; i < 2; i++) {
      workspaces.push(
        await insert('INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)', [
          randomUUID(),
          owner,
        ]),
      );
      targets.push(
        await insert(
          'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
          ['validation.argus.test', 'DOMAIN', workspaces[i]],
        ),
      );
      assets.push(
        await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
          'host.validation.argus.test',
          targets[i],
        ]),
      );
    }
  });
  afterAll(async () => {
    if (db?.isTransactionActive) await db.rollbackTransaction();
    await db?.release();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('accepts and canonicalizes owned references alongside hostname and CIDR rules', async () => {
    const input = [
      rule(Kind.TARGET, targets[0].toUpperCase()),
      rule(Kind.ASSET, assets[0].toUpperCase()),
      rule(Kind.HOSTNAME, '*.ARGUS.TEST '),
      rule(Kind.CIDR, '192.0.2.7'),
    ];
    expect(await service.normalizeRules(workspaces[0], input)).toEqual([
      rule(Kind.TARGET, targets[0]),
      rule(Kind.ASSET, assets[0]),
      rule(Kind.HOSTNAME, '*.argus.test'),
      rule(Kind.CIDR, '192.0.2.7/32'),
    ]);
  });
  it.each([Kind.TARGET, Kind.ASSET])(
    'rejects existing %s references from another workspace',
    async (kind) => {
      const foreign = kind === Kind.TARGET ? targets[1] : assets[1];
      await expect(
        service.normalizeRules(workspaces[0], [rule(kind, foreign)]),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it.each([Kind.TARGET, Kind.ASSET])(
    'rejects a nonexistent %s reference',
    async (kind) => {
      await expect(
        service.normalizeRules(workspaces[0], [rule(kind, randomUUID())]),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
