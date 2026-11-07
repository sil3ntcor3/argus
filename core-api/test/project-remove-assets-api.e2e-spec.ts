import { AuditOutcome } from '@/common/enums/enum';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { EVENT_CATALOG } from '@/modules/event-bridge/contracts/event-catalog';
import type { EventEnvelopeData } from '@/modules/event-bridge/contracts/event-envelope';
import { syncProjectScope } from '@/modules/projects/project-scope-sync';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import type { QueryRunner } from 'typeorm';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project asset removal API (e2e)', () => {
  let app: TestApp, observer: QueryRunner;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let project: string, foreign: string, role: string;
  const assets: string[] = [];
  let activity: EventEnvelopeData[], runtime: EventEnvelopeData[];
  let observed: Promise<{ members: unknown[]; excluded: string[] }> | undefined;
  let restore: (() => void) | undefined;
  const path = (id: string) => '/api/projects/' + id + '/assets';
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const members = () =>
    app.dataSource.query<
      { assetId: string; source: string; scopeRuleId: string | null }[]
    >(
      'SELECT "assetId",source,"scopeRuleId" FROM project_assets WHERE "projectId"=$1 ORDER BY "assetId"',
      [project],
    );
  const rules = () =>
    app.dataSource.query<{ mode: string; value: string }[]>(
      'SELECT mode,value FROM project_scope_rules WHERE "projectId"=$1 ORDER BY mode,value',
      [project],
    );
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'remove-api-owner');
    reader = await createUserWithWorkspace(app.server, 'remove-api-reader');
    for (const [index, context] of [owner, reader].entries()) {
      const id = await insert(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
        [randomUUID(), context.workspace.id],
      );
      if (index === 0) project = id;
      else foreign = id;
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['remove-api.argus.test', 'DOMAIN', context.workspace.id],
      );
      for (const name of index === 0 ? ['keep', 'rule', 'manual'] : ['foreign'])
        assets.push(
          await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
            name + '.remove-api.argus.test',
            target,
          ]),
        );
    }
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      ['Removal reader', ['project.read'], owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
    observer = app.dataSource.createQueryRunner();
    await observer.connect();
  });
  beforeEach(async () => {
    await app.dataSource.query(
      'DELETE FROM project_assets WHERE "projectId"=$1',
      [project],
    );
    await app.dataSource.query(
      'DELETE FROM project_scope_rules WHERE "projectId"=$1',
      [project],
    );
    const rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'hostname', '*.remove-api.argus.test'],
    );
    for (let i = 0; i < 3; i++)
      await app.dataSource.query(
        'INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId") VALUES ($1,$2,$3,$4)',
        [
          project,
          assets[i],
          i === 2 ? 'manual' : 'rule',
          i === 2 ? null : rule,
        ],
      );
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [['project.read'], role],
    );
    activity = [];
    runtime = [];
    observed = undefined;
    const bridge = app.app.get(EventBridgeService);
    const fact = jest
      .spyOn(bridge, 'publishSafely')
      .mockImplementation((name, data) => {
        if (
          name === EVENT_CATALOG.project.assets.added ||
          name === EVENT_CATALOG.project.assets.added.name
        )
          runtime.push(data as EventEnvelopeData);
        return Promise.resolve(null);
      });
    const audit = jest
      .spyOn(bridge, 'publish')
      .mockImplementation(async (name, raw) => {
        const data = raw as EventEnvelopeData;
        if (
          name === EVENT_CATALOG.project.updated.name &&
          data?.metadata?.change === 'assets.removed'
        ) {
          activity.push(data);
          if (
            data.outcome === AuditOutcome.Success &&
            data.metadata.removed === 2
          ) {
            observed = (async () => {
              const members = await observer.manager.query<unknown[]>(
                'SELECT "assetId" FROM project_assets WHERE "projectId"=$1 AND "assetId"=ANY($2::uuid[])',
                [project, [assets[1], assets[2]]],
              );
              const excluded = await observer.manager.query<
                { value: string }[]
              >(
                'SELECT value FROM project_scope_rules WHERE "projectId"=$1 AND mode=$2',
                [project, 'exclude'],
              );
              return {
                members,
                excluded: excluded.map((row) => row.value).sort(),
              };
            })();
            await observed;
          }
        }
        return '1-0';
      });
    restore = () => {
      fact.mockRestore();
      audit.mockRestore();
    };
  });
  afterEach(() => restore?.());
  afterAll(async () => {
    await observer?.release();
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  it('commits durable removal before user activity, returns actual counts, preserves assets and keeps legacy missing-member errors', async () => {
    const response = await request(app.server)
      .delete(path(project.toUpperCase()))
      .set(owner.headers)
      .send({ assetIds: [assets[1].toUpperCase(), assets[1], assets[2]] })
      .expect(200);
    expect(response.body).toEqual({
      message: '2 assets removed from the project',
      count: 2,
    });
    expect(await observed).toEqual({
      members: [],
      excluded: [assets[1], assets[2]].sort(),
    });
    expect(activity).toContainEqual(
      expect.objectContaining({
        workspaceId: owner.workspace.id,
        actor: expect.objectContaining({ type: 'user', id: owner.user.userId }),
        metadata: { change: 'assets.removed', removed: 2 },
      }),
    );
    expect((await members()).map((row) => row.assetId)).toEqual([assets[0]]);
    expect(
      (
        await request(app.server)
          .delete(path(project))
          .set(owner.headers)
          .send({ assetIds: [assets[1], assets[2]] })
          .expect(200)
      ).body.count,
    ).toBe(0);
    expect(
      await app.dataSource.transaction((manager) =>
        syncProjectScope(manager, project, owner.workspace.id),
      ),
    ).toEqual({ added: [], removed: 0 });
    expect((await members()).map((row) => row.assetId)).toEqual([assets[0]]);
    const legacy = await request(app.server)
      .delete('/api/asset-group/' + project + '/assets')
      .set(owner.headers)
      .send({ assetIds: [assets[1]] })
      .expect(404);
    expect(JSON.stringify(legacy.body)).toContain(
      'associated with asset group',
    );
    expect(
      (
        await app.dataSource.query(
          'SELECT id FROM assets WHERE id=ANY($1::uuid[])',
          [assets],
        )
      ).length,
    ).toBe(4);
    expect(runtime).toEqual([]);
  });
  it('supports both write grants and authorized empty selections', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    for (const [index, key] of ['project.write', 'group.write'].entries()) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[key], role],
      );
      expect(
        (
          await request(app.server)
            .delete(path(project))
            .set(headers)
            .send({ assetIds: [assets[1]] })
            .expect(200)
        ).body.count,
      ).toBe(index === 0 ? 1 : 0);
    }
    expect(
      (
        await request(app.server)
          .delete(path(project))
          .set(owner.headers)
          .send({ assetIds: [] })
          .expect(200)
      ).body.count,
    ).toBe(0);
    expect(runtime).toEqual([]);
  });
  it('counts missing or foreign candidates as zero and removes only owned members from a mixed selection', async () => {
    const before = await members(),
      savedRules = await rules();
    expect(
      (
        await request(app.server)
          .delete(path(project))
          .set(owner.headers)
          .send({ assetIds: [assets[3], randomUUID()] })
          .expect(200)
      ).body.count,
    ).toBe(0);
    expect(await members()).toEqual(before);
    expect(await rules()).toEqual(savedRules);
    expect(
      (
        await request(app.server)
          .delete(path(project))
          .set(owner.headers)
          .send({ assetIds: [assets[1], assets[3]] })
          .expect(200)
      ).body.count,
    ).toBe(1);
    expect(
      (await rules())
        .filter((row) => row.mode === 'exclude')
        .map((row) => row.value),
    ).toEqual([assets[1]]);
    expect(runtime).toEqual([]);
  });
  it('rejects invalid arrays and unauthorized project requests without partial changes or success counts', async () => {
    const before = await members(),
      savedRules = await rules(),
      data = { assetIds: [assets[1]] };
    for (const body of [
      {},
      { assetIds: null },
      { assetIds: 'invalid' },
      { assetIds: [null] },
      { assetIds: ['invalid'] },
      { assetIds: [assets[1], assets[1]] },
      { assetIds: Array.from({ length: 1001 }, () => randomUUID()) },
    ])
      await request(app.server)
        .delete(path(project))
        .set(owner.headers)
        .send(body)
        .expect(400);
    await request(app.server)
      .delete(path(project))
      .set({ ...reader.headers, 'X-Workspace-Id': owner.workspace.id })
      .send(data)
      .expect(403);
    await request(app.server)
      .delete(path(project))
      .set('X-Workspace-Id', owner.workspace.id)
      .send(data)
      .expect(401);
    for (const id of [foreign, randomUUID()])
      await request(app.server)
        .delete(path(id))
        .set(owner.headers)
        .send({ assetIds: [] })
        .expect(404);
    await request(app.server)
      .delete(path('invalid'))
      .set(owner.headers)
      .send(data)
      .expect(400);
    expect(await members()).toEqual(before);
    expect(await rules()).toEqual(savedRules);
    expect(runtime).toEqual([]);
    expect(activity.length).toBeGreaterThan(0);
    expect(
      activity.every(
        (event) =>
          event.outcome === AuditOutcome.Failure &&
          event.metadata?.removed === undefined,
      ),
    ).toBe(true);
  });
});
