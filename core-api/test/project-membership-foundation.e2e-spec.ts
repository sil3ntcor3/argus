import { AssetGroupAsset } from '@/modules/asset-group/entities/asset-groups-assets.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Private project membership provenance (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  const fixtures: { project: string; asset: string; link: AssetGroupAsset }[] =
    [];
  const insert = async (sql: string, values: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(
        sql + ' RETURNING id',
        values,
      )
    )[0].id;
  const stored = async (id: string) =>
    (
      await app.dataSource.query<Record<string, unknown>[]>(
        'SELECT source,"scopeRuleId" FROM project_assets WHERE id=$1',
        [id],
      )
    )[0];
  const assertPrivate = (value: object) => {
    const json = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    for (const key of ['source', 'scopeRuleId', 'scopeRule'])
      expect(json).not.toHaveProperty(key);
    return json;
  };
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'membership-owner');
    other = await createUserWithWorkspace(app.server, 'membership-other');
    for (const user of [owner, other]) {
      const project = await insert(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
        [randomUUID(), user.workspace.id],
      );
      const name = randomUUID() + '.argus.test';
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        [name, 'DOMAIN', user.workspace.id],
      );
      const asset = await insert(
        'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
        [name, target],
      );
      const repo = app.dataSource.getRepository(AssetGroupAsset);
      const link = await repo.save(
        repo.create({ assetGroup: { id: project }, asset: { id: asset } }),
      );
      fixtures.push({ project, asset, link });
    }
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('defaults existing-style memberships to manual while keeping ORM reads and saved JSON private', async () => {
    const { link } = fixtures[0];
    expect(await stored(link.id)).toEqual({
      source: 'manual',
      scopeRuleId: null,
    });
    expect(assertPrivate(link)).toMatchObject({
      id: link.id,
      asset: { id: fixtures[0].asset },
      assetGroup: { id: fixtures[0].project },
    });
    const ordinary = await app.dataSource
      .getRepository(AssetGroupAsset)
      .findOneByOrFail({ id: link.id });
    for (const key of ['source', 'scopeRuleId'])
      expect(
        (ordinary as unknown as Record<string, unknown>)[key],
      ).toBeUndefined();
  });

  it('retains membership when its include rule is removed and hides explicitly loaded provenance', async () => {
    const f = fixtures[0];
    const rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [f.project, 'include', 'hostname', '*.argus.test'],
    );
    await app.dataSource.query(
      'UPDATE project_assets SET source=$1,"scopeRuleId"=$2 WHERE id=$3',
      ['rule', rule, f.link.id],
    );
    const loaded = await app.dataSource
      .getRepository(AssetGroupAsset)
      .createQueryBuilder('link')
      .addSelect(['link.source', 'link.scopeRuleId'])
      .leftJoinAndSelect('link.scopeRule', 'rule')
      .leftJoinAndSelect('link.asset', 'asset')
      .leftJoinAndSelect('link.assetGroup', 'project')
      .where('link.id=:id', { id: f.link.id })
      .getOneOrFail();
    expect(await stored(f.link.id)).toEqual({
      source: 'rule',
      scopeRuleId: rule,
    });
    expect(assertPrivate(loaded)).toMatchObject({
      id: f.link.id,
      asset: { id: f.asset },
      assetGroup: { id: f.project },
    });
    await app.dataSource.query(
      'DELETE FROM project_scope_rules WHERE id=$1 AND "projectId"=$2',
      [rule, f.project],
    );
    expect(await stored(f.link.id)).toEqual({
      source: 'rule',
      scopeRuleId: null,
    });
  });

  it('preserves legacy add/list/remove and workspace isolation without exposing provenance', async () => {
    const made = await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({ name: randomUUID() })
      .expect(201);
    const path =
      '/api/asset-group/' + (made.body as { id: string }).id + '/assets';
    await request(app.server)
      .post(path)
      .set(owner.headers)
      .send({ assetIds: [fixtures[1].asset] })
      .expect(404);
    const added = await request(app.server)
      .post(path)
      .set(owner.headers)
      .send({ assetIds: [fixtures[0].asset] })
      .expect(201);
    expect(Object.keys(added.body)).toEqual(['message']);
    const list = await request(app.server)
      .get(path)
      .set(owner.headers)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(assertPrivate(list.body.data[0] as object)).toMatchObject({
      id: fixtures[0].asset,
    });
    await request(app.server).get(path).set(other.headers).expect(404);
    await request(app.server)
      .delete(path)
      .set(owner.headers)
      .send({ assetIds: [fixtures[0].asset] })
      .expect(200);
    expect(
      (await request(app.server).get(path).set(owner.headers).expect(200)).body
        .data,
    ).toEqual([]);
  });

  it('enforces the rule reference and cascades only the deleted project membership', async () => {
    await expect(
      app.dataSource.query(
        'UPDATE project_assets SET "scopeRuleId"=$1 WHERE id=$2',
        [randomUUID(), fixtures[0].link.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await request(app.server)
      .delete('/api/projects/' + fixtures[0].project)
      .set(owner.headers)
      .expect(200);
    expect(await stored(fixtures[0].link.id)).toBeUndefined();
    expect(await stored(fixtures[1].link.id)).toEqual({
      source: 'manual',
      scopeRuleId: null,
    });
  });
});
