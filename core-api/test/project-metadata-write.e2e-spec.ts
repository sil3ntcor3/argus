import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project metadata writes (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  const create = (body: object) =>
    request(app.server).post('/api/projects').set(owner.headers).send(body);
  const patch = (id: string, body: object) =>
    request(app.server)
      .patch('/api/projects/' + id)
      .set(owner.headers)
      .send(body);
  const stored = async (id: string) =>
    (
      await app.dataSource.query<Record<string, unknown>[]>(
        'SELECT description,"autoAddAssets","archivedAt" FROM projects WHERE id=$1 AND "workspaceId"=$2',
        [id, owner.workspace.id],
      )
    )[0];
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'metadata-writer');
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('persists normalized metadata during creation and patch with public responses', async () => {
    const created = await create({
      name: randomUUID(),
      description: '  Argus scope ✓  ',
      autoAddAssets: false,
    }).expect(201);
    const id = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({
      description: 'Argus scope ✓',
      autoAddAssets: false,
      totalAssets: 0,
    });
    expect(created.body).not.toHaveProperty('archivedAt');
    expect(await stored(id)).toEqual({
      description: 'Argus scope ✓',
      autoAddAssets: false,
      archivedAt: null,
    });
    const updated = await patch(id, {
      description: '  Revised  ',
      autoAddAssets: true,
    }).expect(200);
    expect(updated.body).toMatchObject({
      description: 'Revised',
      autoAddAssets: true,
    });
    expect(await stored(id)).toMatchObject({
      description: 'Revised',
      autoAddAssets: true,
    });
    const detail = await request(app.server)
      .get('/api/projects/' + id)
      .set(owner.headers)
      .expect(200);
    expect(detail.body).toMatchObject({
      description: 'Revised',
      autoAddAssets: true,
    });
  });

  it('uses defaults, clears null or blank descriptions and preserves omitted fields', async () => {
    const created = await create({ name: randomUUID() }).expect(201);
    const id = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({
      description: null,
      autoAddAssets: true,
    });
    await patch(id, { description: 'Keep', autoAddAssets: false }).expect(200);
    await patch(id, { name: randomUUID() }).expect(200);
    expect(await stored(id)).toMatchObject({
      description: 'Keep',
      autoAddAssets: false,
    });
    for (const description of [null, '   ', '']) {
      const changed = await patch(id, { description }).expect(200);
      expect(changed.body).toMatchObject({
        description: null,
        autoAddAssets: false,
      });
    }
    await patch(id, { description: 'a'.repeat(2000) }).expect(200);
    expect((await stored(id)).description).toHaveLength(2000);
  });

  it('rejects invalid metadata and canonical name/color values before changing persistence', async () => {
    const created = await create({
      name: randomUUID(),
      description: 'Stable',
      autoAddAssets: false,
    }).expect(201);
    const id = (created.body as { id: string }).id;
    for (const invalid of [
      { description: 42 },
      { description: {} },
      { description: 'a'.repeat(2001) },
      { autoAddAssets: null },
      { autoAddAssets: 'false' },
      { autoAddAssets: 0 },
      { name: 'a'.repeat(121) },
      { hexColor: 'invalid' },
    ]) {
      await create({ name: randomUUID(), ...invalid }).expect(400);
      await patch(id, invalid).expect(400);
    }
    expect(await stored(id)).toEqual({
      description: 'Stable',
      autoAddAssets: false,
      archivedAt: null,
    });
  });

  it('retains metadata through legacy mutations and never exposes archive state', async () => {
    const created = await create({
      name: randomUUID(),
      description: 'Private to legacy',
      autoAddAssets: false,
      archivedAt: new Date().toISOString(),
    }).expect(201);
    const id = (created.body as { id: string }).id;
    const legacy = await request(app.server)
      .patch('/api/asset-group/' + id)
      .set(owner.headers)
      .send({ name: randomUUID(), description: 'Ignored', autoAddAssets: true })
      .expect(200);
    for (const key of ['description', 'autoAddAssets', 'archivedAt'])
      expect(legacy.body).not.toHaveProperty(key);
    expect(await stored(id)).toEqual({
      description: 'Private to legacy',
      autoAddAssets: false,
      archivedAt: null,
    });
    const old = await request(app.server)
      .post('/api/asset-group')
      .set(owner.headers)
      .send({
        name: randomUUID(),
        description: 'Ignored',
        autoAddAssets: false,
      })
      .expect(201);
    expect(await stored((old.body as { id: string }).id)).toEqual({
      description: null,
      autoAddAssets: true,
      archivedAt: null,
    });
  });

  it('removes the initial project and its metadata when workflow creation fails', async () => {
    const name = randomUUID();
    await create({
      name,
      description: 'Rollback',
      autoAddAssets: false,
      toolIds: [randomUUID()],
    }).expect(404);
    expect(
      await app.dataSource.query(
        'SELECT id FROM projects WHERE name=$1 AND "workspaceId"=$2',
        [name, owner.workspace.id],
      ),
    ).toEqual([]);
  });
});
