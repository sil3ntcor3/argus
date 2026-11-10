import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Artifact folder reads (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let peer: typeof owner;
  let groupId: string;
  const root = randomUUID();
  const child = randomUUID();
  const otherRoot = randomUUID();
  const peerRoot = randomUUID();
  const foreign = randomUUID();
  const mixedOwner = randomUUID();
  const cycle = randomUUID();
  const list = (headers: Record<string, string>) =>
    request(app.server).get('/api/artifact-folders').set(headers);
  const detail = (id: string, headers: Record<string, string>) =>
    request(app.server).get(`/api/artifact-folders/${id}`).set(headers);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'folder-owner');
    peer = await createUserWithWorkspace(app.server, 'folder-peer');
    const db = app.dataSource;
    const [{ id: member }] = await db.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2) RETURNING id',
      [owner.workspace.id, peer.user.userId],
    );
    [{ id: groupId }] = await db.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions ("workspaceId", name, permissions) VALUES ($1, $2, $3) RETURNING id',
      [owner.workspace.id, 'Folder reader', ['artifact.manage']],
    );
    await db.query('INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)', [member, groupId]);
    for (const [id, workspaceId, creator, parent, name] of [
      [otherRoot, owner.workspace.id, owner.user.userId, null, 'Zebra'],
      [root, owner.workspace.id, owner.user.userId, null, 'Alpha'],
      [child, owner.workspace.id, owner.user.userId, root, 'Child'],
      [peerRoot, owner.workspace.id, peer.user.userId, null, 'Peer private'],
      [foreign, peer.workspace.id, owner.user.userId, null, 'Foreign workspace'],
      [mixedOwner, owner.workspace.id, owner.user.userId, peerRoot, 'Corrupt ownership'],
      [cycle, owner.workspace.id, owner.user.userId, cycle, 'Corrupt cycle'],
    ]) {
      await db.query(`INSERT INTO artifact_folders (id, "workspaceId", "createdByUserId", "parentFolderId", name)
        VALUES ($1, $2, $3, $4, $5)`, [id, workspaceId, creator, parent, name]);
    }
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, peer?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, peer?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('lists only the caller’s root folders or direct children, with private cache policy', async () => {
    const roots = await list(owner.headers).expect(200);
    expect(roots.headers['cache-control']).toBe('private, no-store');
    expect(roots.body).toEqual([
      { id: root, name: 'Alpha', parentFolderId: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
      { id: otherRoot, name: 'Zebra', parentFolderId: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
    ]);
    const nested = await list(owner.headers).query({ parentFolderId: root }).expect(200);
    expect(nested.body).toEqual([
      { id: child, name: 'Child', parentFolderId: root, createdAt: expect.any(String), updatedAt: expect.any(String) },
    ]);
  });

  it('returns a root-first breadcrumb and hides peer, foreign, missing, or corrupt folder paths', async () => {
    const result = await detail(child, owner.headers).expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      id: child, name: 'Child', parentFolderId: root, createdAt: expect.any(String), updatedAt: expect.any(String),
      path: [{ id: root, name: 'Alpha' }, { id: child, name: 'Child' }],
    });
    for (const id of [peerRoot, foreign, randomUUID(), mixedOwner, cycle]) {
      await detail(id, owner.headers).expect(404);
      await list(owner.headers).query({ parentFolderId: id }).expect(404);
    }
  });

  it('requires authentication and artifact.read and rejects malformed IDs', async () => {
    const peerHeaders = wsHeaders(peer.user.cookie, owner.workspace.id);
    await list({}).expect(401);
    await detail(child, {}).expect(401);
    await list(peerHeaders).expect(403);
    await detail(peerRoot, peerHeaders).expect(403);
    await list(owner.headers).query({ parentFolderId: 'invalid' }).expect(400);
    await detail('invalid', owner.headers).expect(400);

    await app.dataSource.query('UPDATE workspace_permissions SET permissions = $1 WHERE id = $2', [
      ['artifact.read', 'artifact.manage'], groupId,
    ]);
    const roots = await list(peerHeaders).expect(200);
    expect(roots.body).toMatchObject([{ id: peerRoot }]);
    await detail(root, peerHeaders).expect(404);
  });

  it('keeps listing and detail consistent at the folder depth limit', async () => {
    const chain = [root, child];
    for (let depth = 2; depth <= 101; depth++) {
      const id = randomUUID();
      await app.dataSource.query(
        'INSERT INTO artifact_folders (id, "workspaceId", "createdByUserId", "parentFolderId", name) VALUES ($1, $2, $3, $4, $5)',
        [id, owner.workspace.id, owner.user.userId, chain[depth - 1], `Depth ${depth}`],
      );
      chain.push(id);
    }

    const supported = await detail(chain[100], owner.headers).expect(200);
    expect(supported.body.path.map(({ id }: { id: string }) => id)).toEqual(chain.slice(0, 101));
    const children = await list(owner.headers).query({ parentFolderId: chain[100] }).expect(200);
    expect(children.body).toEqual([]);
    await detail(chain[101], owner.headers).expect(404);
  });
});
