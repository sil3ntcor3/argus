import { AssetGroupAsset } from '@/modules/asset-group/entities/asset-groups-assets.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { Repository, type FindManyOptions } from 'typeorm';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Unique atomic legacy project memberships (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let assetIds: string[], foreignAsset: string;
  const group = async () =>
    (
      await request(app.server)
        .post('/api/projects')
        .set(owner.headers)
        .send({ name: randomUUID() })
        .expect(201)
    ).body.id as string;
  const add = (id: string, assets = [assetIds[0]]) =>
    request(app.server)
      .post('/api/asset-group/' + id + '/assets')
      .set(owner.headers)
      .send({ assetIds: assets });
  const rows = (id: string) =>
    app.dataSource.query<{ assetId: string }[]>(
      'SELECT "assetId" FROM project_assets WHERE "projectId"=$1 ORDER BY "assetId"',
      [id],
    );
  beforeAll(async () => {
    app = await createTestApp();
    // Keep one listening server for concurrent requests instead of per-test closes.
    await app.app.listen(0, '127.0.0.1');
    owner = await createUserWithWorkspace(app.server, 'unique-owner');
    other = await createUserWithWorkspace(app.server, 'unique-other');
    const assets: string[][] = [];
    for (const user of [owner, other]) {
      const target = (
        await app.dataSource.query<{ id: string }[]>(
          'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3) RETURNING id',
          [randomUUID() + '.argus.test', 'DOMAIN', user.workspace.id],
        )
      )[0].id;
      const created = await app.dataSource.query<{ id: string }[]>(
        'INSERT INTO assets (value,"targetId") VALUES ($1,$2),($3,$2) RETURNING id',
        [randomUUID() + '.argus.test', target, randomUUID() + '.argus.test'],
      );
      assets.push(created.map((row) => row.id));
    }
    [assetIds] = assets;
    foreignAsset = assets[1][0];
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('returns the existing 400 response for an already attached asset', async () => {
    const id = await group();
    await add(id).expect(201);
    const again = await add(id).expect(400);
    expect(again.body.message).toContain('already associated');
    expect(await rows(id)).toEqual([{ assetId: assetIds[0] }]);
  });

  it('admits one concurrent add and returns 400 for every competing request', async () => {
    const id = await group();
    const statuses = (
      await Promise.all(Array.from({ length: 8 }, () => add(id)))
    ).map((row) => row.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(7);
    expect(await rows(id)).toEqual([{ assetId: assetIds[0] }]);
  });

  it('rejects a mixed duplicate/new batch without persisting a partial addition', async () => {
    const id = await group();
    await add(id).expect(201);
    await add(id, assetIds).expect(400);
    expect(await rows(id)).toEqual([{ assetId: assetIds[0] }]);
  });

  it('rolls back the real database save when the duplicate precheck is stale', async () => {
    const id = await group();
    await add(id, [assetIds[1]]).expect(201);
    const find = Repository.prototype
      .find as Repository<AssetGroupAsset>['find'];
    let bypassed = false;
    const stale = jest
      .spyOn(Repository.prototype, 'find')
      .mockImplementation(function (
        this: Repository<AssetGroupAsset>,
        options?: FindManyOptions<AssetGroupAsset>,
      ) {
        if (
          this.target === AssetGroupAsset &&
          this.manager.queryRunner?.isTransactionActive &&
          JSON.stringify(options?.where).includes(id)
        ) {
          bypassed = true;
          return Promise.resolve([]);
        }
        const original = find.bind(this) as Repository<AssetGroupAsset>['find'];
        return original(options);
      });
    try {
      await add(id, assetIds).expect(400);
      expect(bypassed).toBe(true);
      expect(await rows(id)).toEqual([{ assetId: assetIds[1] }]);
    } finally {
      stale.mockRestore();
    }
  });

  it('enforces each project/asset pair while preserving multi-project membership and tenant boundaries', async () => {
    const ids = [await group(), await group()];
    for (const id of ids) await add(id).expect(201);
    await expect(
      app.dataSource.query(
        'INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)',
        [ids[0], assetIds[0]],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_pa_projectId_assetId',
    });
    await add(ids[0], [foreignAsset]).expect(404);
    await request(app.server)
      .post('/api/asset-group/' + ids[0] + '/assets')
      .set(other.headers)
      .send({ assetIds: [foreignAsset] })
      .expect(404);
    for (const id of ids)
      expect(await rows(id)).toEqual([{ assetId: assetIds[0] }]);
  });
});
