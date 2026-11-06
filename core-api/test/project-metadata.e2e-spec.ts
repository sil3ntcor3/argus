import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Private project metadata foundation (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  const privateKeys = ['description', 'autoAddAssets', 'archivedAt'];
  const assertPrivate = (value: Record<string, unknown>) => {
    for (const key of privateKeys) expect(value).not.toHaveProperty(key);
  };
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'project-metadata');
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('persists upstream defaults while default entity reads omit private columns', async () => {
    const repo = app.dataSource.getRepository(AssetGroup);
    const saved = await repo.save(
      repo.create({
        name: randomUUID(),
        workspace: { id: owner.workspace.id },
      }),
    );
    const [stored] = await app.dataSource.query<Record<string, unknown>[]>(
      'SELECT description, "autoAddAssets", "archivedAt" FROM projects WHERE id=$1',
      [saved.id],
    );
    expect(stored).toEqual({
      description: null,
      autoAddAssets: true,
      archivedAt: null,
    });
    const ordinary = await repo.findOneByOrFail({ id: saved.id });
    for (const key of privateKeys)
      expect(
        (ordinary as unknown as Record<string, unknown>)[key],
      ).toBeUndefined();
    assertPrivate(JSON.parse(JSON.stringify(saved)) as Record<string, unknown>);
  });

  it('keeps explicitly loaded metadata out of JSON while retaining public fields', async () => {
    const repo = app.dataSource.getRepository(AssetGroup);
    const saved = await repo.save(
      repo.create({
        name: randomUUID(),
        hexColor: '#123456',
        workspace: { id: owner.workspace.id },
      }),
    );
    await app.dataSource.query(
      'UPDATE projects SET description=$1, "autoAddAssets"=false, "archivedAt"=$2 WHERE id=$3',
      ['Argus metadata ✓', '2026-11-06T00:00:00.000Z', saved.id],
    );
    const loaded = await repo
      .createQueryBuilder('project')
      .addSelect(privateKeys.map((key) => `project.${key}`))
      .where('project.id=:id', { id: saved.id })
      .getOneOrFail();
    const internal = loaded as unknown as {
      description: string;
      autoAddAssets: boolean;
      archivedAt: Date;
    };
    expect(internal.description).toBe('Argus metadata ✓');
    expect(internal.autoAddAssets).toBe(false);
    expect(internal.archivedAt.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    loaded.totalAssets = 7;
    loaded.assetGroupWorkflows = [];
    const json = JSON.parse(JSON.stringify(loaded)) as Record<string, unknown>;
    assertPrivate(json);
    expect(json).toMatchObject({
      id: saved.id,
      name: saved.name,
      hexColor: '#123456',
      totalAssets: 7,
      assetGroupWorkflows: [],
    });
  });

  it.each(['asset-group', 'projects'])(
    'preserves %s create, list, read and update responses',
    async (prefix) => {
      const name = randomUUID();
      const input = {
        name,
        description: 'Not a public input',
        autoAddAssets: false,
        archivedAt: '2026-11-06T00:00:00.000Z',
      };
      const created = await request(app.server)
        .post('/api/' + prefix)
        .set(owner.headers)
        .send(input)
        .expect(201);
      assertPrivate(created.body as Record<string, unknown>);
      const id = (created.body as { id: string }).id;
      const detail = await request(app.server)
        .get(`/api/${prefix}/${id}`)
        .set(owner.headers)
        .expect(200);
      assertPrivate(detail.body as Record<string, unknown>);
      const list = await request(app.server)
        .get('/api/' + prefix)
        .query({ search: name })
        .set(owner.headers)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      assertPrivate(list.body.data[0] as Record<string, unknown>);
      const updated = await request(app.server)
        .patch(`/api/${prefix}/${id}`)
        .set(owner.headers)
        .send({ ...input, name: name + ' saved' })
        .expect(200);
      assertPrivate(updated.body as Record<string, unknown>);
      expect(
        await app.dataSource.query(
          'SELECT description, "autoAddAssets", "archivedAt" FROM projects WHERE id=$1',
          [id],
        ),
      ).toEqual([{ description: null, autoAddAssets: true, archivedAt: null }]);
    },
  );
});
