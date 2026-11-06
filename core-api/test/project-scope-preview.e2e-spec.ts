import { dataSourceOptions } from '@/database/database-config';
import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { ProjectScopeNormalizer } from '@/modules/projects/project-scope-normalizer.service';
import { ProjectScopePreviewService } from '@/modules/projects/project-scope-preview.service';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

describe('Project scope preview calculations (e2e)', () => {
  let ds: DataSource, db: QueryRunner, service: ProjectScopePreviewService;
  let workspace: string, project: string, foreignProject: string;
  const include = {
    mode: Mode.INCLUDE,
    type: Kind.HOSTNAME,
    value: '*.argus.test',
  };
  const exclude = {
    mode: Mode.EXCLUDE,
    type: Kind.HOSTNAME,
    value: 'dev.argus.test',
  };
  const insert = async (sql: string, values: unknown[]) =>
    (await db.manager.query<{ id: string }[]>(sql + ' RETURNING id', values))[0]
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
    const executor = {
      query: (sql: string, values: unknown[]) => db.query(sql, values),
    };
    service = new ProjectScopePreviewService(
      executor as never,
      new ProjectScopeNormalizer(executor as never),
    );
    const owner = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus scope preview', randomUUID() + '@example.test'],
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
      } else foreignProject = p;
      for (const value of i === 0
        ? ['api.argus.test', 'dev.argus.test', 'manual.example.test']
        : ['foreign.argus.test']) {
        const asset = await insert(
          'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
          [value, target],
        );
        if (value !== 'api.argus.test') {
          // A malformed historical foreign link must neither count nor be changed.
          await insert(
            'INSERT INTO project_assets ("projectId","assetId",source) VALUES ($1,$2,$3)',
            [project, asset, 'manual'],
          );
        }
      }
    }
  });
  afterAll(async () => {
    if (db?.isTransactionActive) await db.rollbackTransaction();
    await db?.release();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('combines rule matches and owned manual members without double-counting or removing excluded manual members', async () => {
    const before = await db.manager.query<object[]>(
      'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
      [project],
    );
    expect(
      await service.preview(workspace, [include, exclude], project),
    ).toEqual({ ruleAssets: 1, total: 3, perRule: [2, 1] });
    expect(
      await db.manager.query<object[]>(
        'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
        [project],
      ),
    ).toEqual(before);
  });
  it('keeps counts aligned with input indices after canonical duplicate rules', async () => {
    expect(
      await service.preview(
        workspace,
        [{ ...include, value: '*.ARGUS.TEST ' }, include, exclude],
        project,
      ),
    ).toEqual({ ruleAssets: 1, total: 3, perRule: [2, 2, 1] });
  });
  it('keeps manual members for empty and exclude-only rules without counting a foreign historical link', async () => {
    expect(await service.preview(workspace, [], project)).toEqual({
      ruleAssets: 0,
      total: 2,
      perRule: [],
    });
    expect(await service.preview(workspace, [exclude], project)).toEqual({
      ruleAssets: 0,
      total: 2,
      perRule: [0],
    });
  });
  it('supports preview without a project and never imports foreign assets', async () => {
    expect(await service.preview(workspace, [include, exclude])).toEqual({
      ruleAssets: 1,
      total: 1,
      perRule: [2, 1],
    });
    expect(await service.preview(workspace, [])).toEqual({
      ruleAssets: 0,
      total: 0,
      perRule: [],
    });
  });
  it.each([true, false])(
    'rejects a foreign or nonexistent project (exists=%s)',
    async (exists) => {
      await expect(
        service.preview(workspace, [], exists ? foreignProject : randomUUID()),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );
});
