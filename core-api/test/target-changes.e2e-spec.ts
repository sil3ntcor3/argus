import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Target changes API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let target: string;
  let otherTarget: string;
  let asset: string;
  let tiedAsset: string;
  let service: string;
  let primaryService: string;
  const early = '2026-01-02T03:04:05.000Z';
  const late = '2026-01-03T03:04:05.000Z';

  const read = (id: string, headers: Record<string, string>, query = '') =>
    request(app.server).get(`/api/targets/${id}/changes${query}`).set(headers);

  async function insertId(sql: string, params: unknown[]) {
    return (
      await app.dataSource.query<{ id: string }[]>(
        `${sql} RETURNING id`,
        params,
      )
    )[0].id;
  }

  function makeTarget(workspaceId: string) {
    return insertId(
      'INSERT INTO targets (value, type, "workspaceId") VALUES ($1, \'DOMAIN\', $2)',
      [`${randomUUID()}.example.test`, workspaceId],
    );
  }

  function makeAsset(id: string, value: string, isPrimary = false) {
    return insertId(
      'INSERT INTO assets (value, "targetId", "isPrimary", "createdAt") VALUES ($1, $2, $3, $4)',
      [value, id, isPrimary, new Date(late)],
    );
  }

  function makeService(assetId: string, label: string, at: string) {
    return insertId(
      'INSERT INTO asset_services ("assetId", value, port, "createdAt") VALUES ($1, $2, 443, $3)',
      [assetId, label, new Date(at)],
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'target-changes-owner');
    other = await createUserWithWorkspace(app.server, 'target-changes-other');
    target = await makeTarget(owner.workspace.id);
    otherTarget = await makeTarget(other.workspace.id);
    const sibling = await makeTarget(owner.workspace.id);
    await makeService(
      await makeAsset(sibling, 'sibling.example.test'),
      'sibling:443',
      late,
    );
    const primary = await makeAsset(target, 'primary.example.test', true);
    asset = await makeAsset(target, 'asset.example.test');
    tiedAsset = await makeAsset(target, 'tied.example.test');
    service = await makeService(asset, 'asset.example.test:443', late);
    primaryService = await makeService(
      primary,
      'primary.example.test:443',
      early,
    );
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

  it('pages asset and service discoveries newest first with a stable tie break', async () => {
    const assetRows = [
      { id: asset, label: 'asset.example.test' },
      { id: tiedAsset, label: 'tied.example.test' },
    ]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({ ...row, kind: 'asset', at: late, assetValue: null }));
    const serviceRows = [
      {
        kind: 'service',
        at: late,
        id: service,
        label: 'asset.example.test:443',
        assetValue: 'asset.example.test',
      },
      {
        kind: 'service',
        at: early,
        id: primaryService,
        label: 'primary.example.test:443',
        assetValue: 'primary.example.test',
      },
    ];
    const rows = [...assetRows, ...serviceRows];
    for (const [index, row] of rows.entries()) {
      await read(target, owner.headers, `?limit=1&page=${index + 1}`)
        .expect(200, {
          page: index + 1,
          limit: 1,
          total: rows.length,
          pageCount: rows.length,
          hasNextPage: index + 1 < rows.length,
          data: [row],
        })
        .expect('Cache-Control', 'private, no-store');
    }
    const outOfRange = await read(
      target,
      owner.headers,
      '?limit=1&page=5',
    ).expect(200);
    expect(outOfRange.body).toMatchObject({
      total: rows.length,
      data: [],
      hasNextPage: false,
    });
    const assets = await read(target, owner.headers, '?kind=asset').expect(200);
    expect(assets.body).toMatchObject({ total: 2, data: assetRows });
    const services = await read(target, owner.headers, '?kind=service').expect(
      200,
    );
    expect(services.body).toMatchObject({ total: 2, data: serviceRows });
  });

  it('validates input and returns the same response for missing and foreign targets', async () => {
    await read(target, owner.headers, '?kind=vulnerability').expect(400);
    await read(target, owner.headers, '?page=1.5').expect(400);
    await read(target, owner.headers, '?limit=101').expect(400);
    await read('invalid', owner.headers).expect(400);
    const empty = await read(otherTarget, other.headers).expect(200);
    expect(empty.body).toMatchObject({
      total: 0,
      data: [],
      page: 1,
      limit: 10,
    });
    const missing = await read(randomUUID(), owner.headers).expect(404);
    const foreign = await read(otherTarget, owner.headers).expect(404);
    expect(foreign.body).toEqual(missing.body);
  });

  it('requires both target and asset read access in the selected workspace', async () => {
    const workspace = owner.workspace.id;
    const headers = wsHeaders(other.user.cookie, workspace);
    await read(target, {}).expect(401);
    await read(target, headers).expect(403);
    const member = await insertId(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2)',
      [workspace, other.user.userId],
    );
    const role = await insertId(
      'INSERT INTO workspace_permissions (name, permissions, "workspaceId") VALUES ($1, $2, $3)',
      [randomUUID(), ['target.read'], workspace],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)',
      [member, role],
    );
    await read(target, headers).expect(403);
    for (const [keys, status] of [
      [['asset.read'], 403],
      [['target.read', 'asset.read'], 200],
    ] as const) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [keys, role],
      );
      await read(target, headers).expect(status);
    }
  });
});
