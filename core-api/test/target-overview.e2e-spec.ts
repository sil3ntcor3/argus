import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Target overview API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let target: string;
  let emptyTarget: string;
  let foreignTarget: string;
  const metrics = {
    totalAssets: 2,
    newAssets: 1,
    totalServices: 4,
    newServices: 3,
    openPorts: 2,
  };

  const overview = (id: string, headers: Record<string, string>) =>
    request(app.server).get(`/api/targets/${id}/overview`).set(headers);

  async function insertId(sql: string, args: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `${sql} RETURNING id`,
      args,
    );
    return row.id;
  }

  function makeTarget(workspaceId: string) {
    return insertId(
      `INSERT INTO targets (value, type, "workspaceId") VALUES ($1, 'DOMAIN', $2)`,
      [`${randomUUID()}.example.test`, workspaceId],
    );
  }

  async function addAsset(id: string, days: number, enabled: boolean) {
    return insertId(
      `INSERT INTO assets (value, "targetId", "isEnabled", "createdAt")
       VALUES ($1, $2, $3, LOCALTIMESTAMP - $4 * INTERVAL '1 day')`,
      [`${randomUUID()}.example.test`, id, enabled, days],
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'overview-owner');
    other = await createUserWithWorkspace(app.server, 'overview-other');
    target = await makeTarget(owner.workspace.id);
    emptyTarget = await makeTarget(owner.workspace.id);
    foreignTarget = await makeTarget(other.workspace.id);

    const recent = await addAsset(target, 6, true);
    const older = await addAsset(target, 8, true);
    const disabled = await addAsset(target, 1, false);
    const foreign = await addAsset(foreignTarget, 1, true);
    for (const [asset, port, days] of [
      [recent, 443, 6],
      [recent, 80, 8],
      [older, 443, 1],
      [disabled, 80, 1],
      [foreign, 22, 1],
    ] as const) {
      await app.dataSource.query(
        `INSERT INTO asset_services (value, port, "assetId", "createdAt")
         VALUES ($1, $2, $3, LOCALTIMESTAMP - $4 * INTERVAL '1 day')`,
        [`https://example.test:${port}`, port, asset, days],
      );
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

  it('counts enabled assets and discovered services without duplicating ports or leaking another target', async () => {
    await overview(target, owner.headers)
      .expect(200, metrics)
      .expect('Cache-Control', 'private, no-store');
    await overview(emptyTarget, owner.headers).expect(200, {
      totalAssets: 0,
      newAssets: 0,
      totalServices: 0,
      newServices: 0,
      openPorts: 0,
    });
    await overview(foreignTarget, other.headers).expect(200, {
      totalAssets: 1,
      newAssets: 1,
      totalServices: 1,
      newServices: 1,
      openPorts: 1,
    });
  });

  it('returns the same 404 for a missing target or one in another workspace', async () => {
    const missing = await overview(randomUUID(), owner.headers).expect(404);
    const foreign = await overview(foreignTarget, owner.headers).expect(404);
    expect(foreign.body).toEqual(missing.body);
    await overview('not-a-uuid', owner.headers).expect(400);
  });

  it('requires both target and asset read access in the selected workspace', async () => {
    const workspace = owner.workspace.id;
    const headers = wsHeaders(other.user.cookie, workspace);
    await overview(target, {}).expect(401);
    await overview(target, headers).expect(403);
    const member = await insertId(
      `INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2)`,
      [workspace, other.user.userId],
    );
    const role = await insertId(
      `INSERT INTO workspace_permissions (name, permissions, "workspaceId") VALUES ($1, $2, $3)`,
      [randomUUID(), ['target.read'], workspace],
    );
    await app.dataSource.query(
      `INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)`,
      [member, role],
    );
    await overview(target, headers).expect(403);
    for (const [permissions, allowed] of [
      [['asset.read'], false],
      [['target.read', 'asset.read'], true],
      [['target.write', 'asset.write'], true],
    ] as const) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [permissions, role],
      );
      if (allowed) await overview(target, headers).expect(200, metrics);
      else await overview(target, headers).expect(403);
    }
  });
});
