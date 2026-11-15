import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Finding sort validation (Docker HTTP)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const list = (query: Record<string, unknown> = {}, headers = owner.headers) =>
    request(app.server).get('/api/vulnerabilities').set(headers).query(query);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'finding-sort');
    other = await createUserWithWorkspace(app.server, 'finding-sort-other');
    for (const workspace of [owner.workspace.id, other.workspace.id]) {
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,\'DOMAIN\',$2)',
        [randomUUID() + '.example.test', workspace],
      );
      const asset = await insert(
        'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
        ['sort.example.test', target],
      );
      for (const [index, [name, severity]] of [
        ['Zulu', 'high'],
        ['Alpha', 'critical'],
        ['Echo', 'medium'],
      ].entries()) {
        await insert(
          'INSERT INTO vulnerabilities (name,severity,"assetId","createdAt") VALUES ($1,$2,$3,$4)',
          [
            (workspace === owner.workspace.id ? '' : 'Foreign ') + name,
            severity,
            asset,
            new Date(Date.UTC(2026, 10, 1 + index)),
          ],
        );
      }
    }
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
          Boolean,
        ),
        userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('keeps severity as the default and applies the existing pagination envelope', async () => {
    const response = await list({ page: 1, limit: 2 }).expect(200);
    expect(response.body).toMatchObject({
      total: 3,
      page: 1,
      limit: 2,
      pageCount: 2,
      hasNextPage: true,
    });
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(
      ['Alpha', 'Zulu'],
    );
  });

  it.each([
    ['name', 'ASC', ['Alpha', 'Echo', 'Zulu']],
    ['name', 'DESC', ['Zulu', 'Echo', 'Alpha']],
    ['createdAt', 'ASC', ['Zulu', 'Alpha', 'Echo']],
    ['createdAt', 'DESC', ['Echo', 'Alpha', 'Zulu']],
  ])('retains %s %s ordering', async (sortBy, sortOrder, expected) => {
    const response = await list({ sortBy, sortOrder }).expect(200);
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(
      expected,
    );
  });

  it('keeps sorted pages distinct and scoped to the selected workspace', async () => {
    const response = await list({
      sortBy: 'name',
      sortOrder: 'ASC',
      page: 2,
      limit: 1,
    }).expect(200);
    expect(response.body).toMatchObject({
      total: 3,
      page: 2,
      limit: 1,
      pageCount: 3,
    });
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(
      ['Echo'],
    );
    const foreign = await list({ sortBy: 'name' }, other.headers).expect(200);
    expect(
      foreign.body.data.every((row: { name: string }) =>
        row.name.startsWith('Foreign '),
      ),
    ).toBe(true);
  });

  it.each([
    'createdAt DESC',
    'a.b',
    'name; SELECT 1',
    'name,createdAt',
    'name--',
    '(name)',
    '1name',
    'naïve',
    '',
    ' name',
    'name\nDESC',
  ])(
    'rejects malformed sortBy %j before query construction',
    async (sortBy) => {
      const response = await list({ sortBy }).expect(400);
      expect(response.body.message).toContain(
        'sortBy must be a plain column name',
      );
      expect(response.body).not.toHaveProperty('data');
    },
  );

  it('retains enum validation for sort direction and membership enforcement', async () => {
    await list({ sortBy: 'name', sortOrder: 'sideways' }).expect(400);
    await list(
      { sortBy: 'name' },
      { ...other.headers, 'X-Workspace-Id': owner.workspace.id },
    ).expect(403);
    await request(app.server)
      .get('/api/vulnerabilities')
      .query({ sortBy: 'name' })
      .expect(401);
  });
});
