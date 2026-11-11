import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Workspace artifact usage API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  const defaults = { quotaBytes: 1073741824, usedBytes: 0, reservedBytes: 0, maxFileBytes: 52428800 };
  const get = (headers: Record<string, string>) => request(app.server).get('/api/artifacts/usage').set(headers);

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'artifact-usage-owner');
    other = await createUserWithWorkspace(app.server, 'artifact-usage-other');
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  async function meter(workspaceId: string, quotaBytes: number | null, usedBytes: number, reservedBytes: number) {
    await app.dataSource.query(
      'INSERT INTO workspace_storage_usage ("workspaceId","quotaBytes","usedBytes","reservedBytes") VALUES ($1,$2,$3,$4)',
      [workspaceId, quotaBytes, usedBytes, reservedBytes],
    );
  }

  it('returns defaults for an unmetered workspace without creating a row', async () => {
    const response = await get(owner.headers).expect(200, defaults);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(await app.dataSource.query(
      'SELECT 1 FROM workspace_storage_usage WHERE "workspaceId"=$1', [owner.workspace.id],
    )).toEqual([]);
  });

  it('keeps a zero override, scopes stored usage, and applies effective artifact read', async () => {
    const workspaceId = owner.workspace.id;
    const userId = other.user.userId;
    await meter(workspaceId, 0, 128, 19);
    await meter(other.workspace.id, null, 8, 5);
    const expected = { ...defaults, quotaBytes: 0, usedBytes: 128, reservedBytes: 19 };
    await get(owner.headers).expect(200, expected);
    await get(other.headers).expect(200, { ...defaults, usedBytes: 8, reservedBytes: 5 });
    const headers = wsHeaders(other.user.cookie, workspaceId);
    await get({}).expect(401);
    await get(headers).expect(403);
    await get(wsHeaders(other.user.cookie, 'invalid')).expect(400);

    const [{ id: member }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2) RETURNING id', [workspaceId, userId],
    );
    const [{ id: group }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3) RETURNING id',
      ['Artifact usage ' + randomUUID(), ['artifact.manage'], workspaceId],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)', [member, group],
    );
    await get(headers).expect(403);
    for (const permission of ['artifact.read', 'artifact.write']) {
      await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [[permission], group]);
      await get(headers).expect(200, expected);
      await get(other.headers).expect(200, { ...defaults, usedBytes: 8, reservedBytes: 5 });
    }
  });
});
