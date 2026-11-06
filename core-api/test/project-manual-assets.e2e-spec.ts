import { dataSourceOptions } from '@/database/database-config';
import { ProjectAssetsService } from '@/modules/projects/project-assets.service';
import {
  lockProjectScope,
  syncProjectScope,
} from '@/modules/projects/project-scope-sync';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource, type EntityManager } from 'typeorm';
import { cleanupE2eData } from './helpers/workspace';

describe('Canonical manual project membership (e2e)', () => {
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
    ds.query<
      {
        assetId: string;
        source: string;
        scopeRuleId: string | null;
        updatedAt: Date;
      }[]
    >(
      'SELECT "assetId",source,"scopeRuleId","updatedAt" FROM project_assets WHERE "projectId"=$1 ORDER BY "assetId"',
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
      [randomUUID(), 'Argus manual selection', randomUUID() + '@example.test'],
    );
    for (let i = 0; i < 2; i++) {
      const ws = await insert(
        'INSERT INTO workspaces (name,"ownerId") VALUES ($1,$2)',
        [randomUUID(), user],
      );
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['manual.argus.test', 'DOMAIN', ws],
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
      for (const name of i === 0 ? ['new', 'rule', 'manual'] : ['foreign'])
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
      [project, 'include', 'asset', assets[1]],
    );
    await ds.query(
      'INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId") VALUES ($1,$2,$3,$4),($1,$5,$6,NULL)',
      [project, assets[1], 'rule', rule, assets[2], 'manual'],
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
  it('adds only missing IDs, deduplicates UUID spellings, promotes rule members and leaves repeated manual additions unchanged', async () => {
    const input = [
      assets[0],
      ' ' + assets[0].toUpperCase() + ' ',
      assets[1],
      assets[2],
    ];
    expect(await service.add(project.toUpperCase(), workspace, input)).toEqual([
      assets[0],
    ]);
    const first = await members();
    expect(first).toHaveLength(3);
    expect(
      first.every((row) => row.source === 'manual' && row.scopeRuleId === null),
    ).toBe(true);
    expect(await service.add(project, workspace, input)).toEqual([]);
    expect(await members()).toEqual(first);
    await ds.query('DELETE FROM project_scope_rules WHERE "projectId"=$1', [
      project,
    ]);
    expect(
      await ds.transaction((m) => syncProjectScope(m, project, workspace)),
    ).toEqual({ added: [], removed: 0 });
    expect(await members()).toEqual(first);
  });
  it('validates every candidate atomically and still authorizes empty requests', async () => {
    const before = await members();
    for (const ids of [
      [assets[0], assets[3]],
      [assets[0], randomUUID()],
    ])
      await expect(service.add(project, workspace, ids)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    for (const ids of [null, {}, ['invalid'], [null], [42]])
      await expect(
        service.add(project, workspace, ids as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    for (const [id, ws] of [
      [foreign, workspace],
      [project, other],
      [randomUUID(), workspace],
    ])
      await expect(service.add(id, ws, [])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    expect(await service.add(project, workspace, [])).toEqual([]);
    expect(await members()).toEqual(before);
  });
  it('rolls back both inserted and promoted memberships when transaction completion fails', async () => {
    const before = await members(),
      failure = new Error('manual membership commit failed');
    const failing = new ProjectAssetsService({
      transaction: (run: (manager: EntityManager) => Promise<unknown>) =>
        ds.transaction(async (manager) => {
          await run(manager);
          throw failure;
        }),
    } as unknown as DataSource);
    await expect(
      failing.add(project, workspace, [assets[0], assets[1]]),
    ).rejects.toBe(failure);
    expect(await members()).toEqual(before);
  });
  it('returns each newly inserted membership once under competing additions', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.add(project, workspace, [assets[0], assets[1]]),
      ),
    );
    expect(results.flat()).toEqual([assets[0]]);
    expect(
      (await members()).every(
        (row) => row.source === 'manual' && row.scopeRuleId === null,
      ),
    ).toBe(true);
  });
  it('waits for the shared scope lock and then uses the committed membership state', async () => {
    const first = ds.createQueryRunner(),
      second = ds.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      await lockProjectScope(first.manager, project, workspace);
      await first.manager.query(
        'DELETE FROM project_scope_rules WHERE "projectId"=$1',
        [project],
      );
      expect(await syncProjectScope(first.manager, project, workspace)).toEqual(
        { added: [], removed: 1 },
      );
      const [{ pid }] = await second.manager.query<{ pid: number }[]>(
        'SELECT pg_backend_pid() AS pid',
      );
      const waiting = new ProjectAssetsService({
        transaction: second.manager.transaction.bind(second.manager),
      } as DataSource);
      pending = waiting.add(project, workspace, [assets[1]]).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await ds.query<{ waiting: boolean }[]>(
          'SELECT wait_event_type=$1 AS waiting FROM pg_stat_activity WHERE pid=$2',
          ['Lock', pid],
        );
        if (state?.waiting) {
          blocked = true;
          break;
        }
        await delay(5);
      }
      expect(blocked).toBe(true);
      await first.commitTransaction();
      expect(await pending).toEqual({ value: [assets[1]] });
      await second.commitTransaction();
      expect(
        await ds.transaction((m) => syncProjectScope(m, project, workspace)),
      ).toEqual({ added: [], removed: 0 });
      expect(
        (await members()).every(
          (row) => row.source === 'manual' && row.scopeRuleId === null,
        ),
      ).toBe(true);
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      await pending;
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release();
      await second.release();
    }
  });
});
