import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { dataSourceOptions } from '@/database/database-config';
import { ProjectScopeNormalizer } from '@/modules/projects/project-scope-normalizer.service';
import type { ScopeSyncResult } from '@/modules/projects/project-scope-sync';
import { ProjectScopeWriteService } from '@/modules/projects/project-scope-write.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Atomic project scope replacement (e2e)', () => {
  let ds: DataSource,
    service: ProjectScopeWriteService,
    normalizer: ProjectScopeNormalizer;
  let owner: string,
    workspace: string,
    other: string,
    project: string,
    foreign: string,
    foreignTarget: string;
  const assets: Record<string, string> = {};
  const input = (value: string) => ({
    mode: Mode.INCLUDE,
    type: Kind.ASSET,
    value,
  });
  const insert = async (sql: string, args: unknown[]) =>
    (await ds.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
  const state = async () => ({
    settings: await ds.query(
      'SELECT "autoAddAssets" FROM projects WHERE id=$1',
      [project],
    ),
    rules: await ds.query<{ id: string; value: string }[]>(
      'SELECT id,mode,type,value FROM project_scope_rules WHERE "projectId"=$1 ORDER BY id',
      [project],
    ),
    members: await ds.query(
      'SELECT "assetId",source,"scopeRuleId" FROM project_assets WHERE "projectId"=$1 ORDER BY "assetId"',
      [project],
    ),
  });
  beforeAll(async () => {
    ds = new DataSource({
      ...dataSourceOptions,
      migrationsRun: false,
      cache: false,
      logging: false,
    });
    await ds.initialize();
    // Any reference validation outside the supplied transaction must fail.
    normalizer = new ProjectScopeNormalizer({
      query: () => {
        throw new Error('Validation escaped transaction');
      },
    } as never);
    service = new ProjectScopeWriteService(ds, normalizer);
    owner = await insert(
      'INSERT INTO users (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
      [randomUUID(), 'Argus scope writes', randomUUID() + '@example.test'],
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
        foreignTarget = target;
      }
      for (const key of i === 0 ? ['api', 'mail', 'manual'] : ['foreign'])
        assets[key] = await insert(
          'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
          [key + '.argus.test', target],
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
    await ds.query('UPDATE projects SET "autoAddAssets"=true WHERE id=$1', [
      project,
    ]);
    await insert(
      'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',
      [project, assets.manual],
    );
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
  it('validates references inside the transaction, canonicalizes duplicates and atomically replaces rules, preference and provenance', async () => {
    const first = await service.replaceRules(
      project.toUpperCase(),
      workspace,
      [
        input(' ' + assets.api.toUpperCase() + ' '),
        input(assets.api),
        input(assets.mail),
      ],
      false,
    );
    expect(first.added.sort()).toEqual([assets.api, assets.mail].sort());
    expect(first.removed).toBe(0);
    const initial = await state();
    expect(initial.settings).toEqual([{ autoAddAssets: false }]);
    expect(initial.rules.map((row) => row.value).sort()).toEqual(
      [assets.api, assets.mail].sort(),
    );
    expect(
      await service.replaceRules(
        project,
        workspace,
        [input(assets.mail)],
        true,
      ),
    ).toEqual({ added: [], removed: 1 });
    const saved = await state();
    expect(saved.settings).toEqual([{ autoAddAssets: true }]);
    expect(saved.rules).toHaveLength(1);
    expect(initial.rules.map((row) => row.id)).not.toContain(saved.rules[0].id);
    expect(saved.members).toEqual(
      [
        {
          assetId: assets.mail,
          source: 'rule',
          scopeRuleId: saved.rules[0].id,
        },
        { assetId: assets.manual, source: 'manual', scopeRuleId: null },
      ].sort((a, b) => a.assetId.localeCompare(b.assetId)),
    );
  });
  it('clears rules without removing manual members or changing an omitted preference', async () => {
    await service.replaceRules(project, workspace, [input(assets.api)], false);
    expect(await service.replaceRules(project, workspace, [])).toEqual({
      added: [],
      removed: 1,
    });
    expect(await state()).toEqual({
      settings: [{ autoAddAssets: false }],
      rules: [],
      members: [
        { assetId: assets.manual, source: 'manual', scopeRuleId: null },
      ],
    });
  });
  it('rejects foreign projects and references without changing saved state', async () => {
    await service.replaceRules(project, workspace, [input(assets.api)]);
    const before = await state();
    for (const id of [foreign, randomUUID()])
      await expect(
        service.replaceRules(id, workspace, [input(assets.api)]),
      ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.replaceRules(project, other, [input(assets.api)]),
    ).rejects.toBeInstanceOf(NotFoundException);
    for (const rule of [
      input(assets.foreign),
      { mode: Mode.INCLUDE, type: Kind.TARGET, value: foreignTarget },
    ]) {
      await expect(
        service.replaceRules(project, workspace, [rule], false),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(await state()).toEqual(before);
  });
  it('rejects invalid shapes, bounds and non-boolean preferences before changing state', async () => {
    const before = await state();
    for (const [rules, flag] of [
      [null, undefined],
      [[null], undefined],
      [Array.from({ length: 101 }, () => input(assets.api)), undefined],
      [[input('a'.repeat(256))], undefined],
      [[{ ...input(assets.api), mode: 'invalid' }], undefined],
      [[], null],
      [[], 'true'],
    ])
      await expect(
        service.replaceRules(project, workspace, rules as never, flag as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    expect(await state()).toEqual(before);
  });
  it('rolls back rule deletion, preference, provenance and membership when reconciliation fails', async () => {
    await service.replaceRules(project, workspace, [input(assets.api)]);
    const before = await state(),
      error = new Error('injected membership failure');
    const failingSource = {
      transaction: (
        run: (manager: EntityManager) => Promise<ScopeSyncResult>,
      ) =>
        ds.transaction(async (manager) => {
          const original = manager.query.bind(manager) as EntityManager['query'];
          manager.query = <T>(sql: string, args?: unknown[]): Promise<T> => {
            if (sql.includes('INSERT INTO project_assets')) {
              return Promise.reject(error);
            }
            return original<T>(sql, args);
          };
          return run(manager);
        }),
    };
    const failing = new ProjectScopeWriteService(
      failingSource as never,
      normalizer,
    );
    await expect(
      failing.replaceRules(project, workspace, [input(assets.mail)], false),
    ).rejects.toBe(error);
    expect(await state()).toEqual(before);
  });
  it('serializes competing replacements into one coherent rule, preference and membership set', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.replaceRules(
          project,
          workspace,
          [input(i % 2 ? assets.mail : assets.api)],
          Boolean(i % 2),
        ),
      ),
    );
    const saved = await state();
    expect(saved.rules).toHaveLength(1);
    const rule = saved.rules[0];
    expect([assets.api, assets.mail]).toContain(rule.value);
    expect(saved.settings).toEqual([
      { autoAddAssets: rule.value === assets.mail },
    ]);
    expect(saved.members).toEqual(
      [
        { assetId: rule.value, source: 'rule', scopeRuleId: rule.id },
        { assetId: assets.manual, source: 'manual', scopeRuleId: null },
      ].sort((a, b) => a.assetId.localeCompare(b.assetId)),
    );
  });
});
