import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Workspace file metadata (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let reader: typeof owner;
  let groupId: string;
  const own = [randomUUID(), randomUUID()].sort();
  const peer = randomUUID();
  const orphan = randomUUID();
  const foreign = randomUUID();
  const pending = randomUUID();
  const deleted = randomUUID();
  const unknown = randomUUID();
  const timestamp = new Date('2026-01-01T00:00:00Z');
  const list = (headers: Record<string, string>) => request(app.server).get('/api/artifacts').set(headers);
  const detail = (id: string, headers: Record<string, string>) =>
    request(app.server).get(`/api/artifacts/${encodeURIComponent(id)}`).set(headers);
  const readerHeaders = () => wsHeaders(reader.user.cookie, owner.workspace.id);
  const permissions = (keys: string[]) => app.dataSource.query(
    'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [keys, groupId],
  );

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'files-owner');
    reader = await createUserWithWorkspace(app.server, 'files-reader');
    const workspaceId = owner.workspace.id;
    const artifact = (id: string, name: string, size: string, createdByUserId: string | null) => ({
      id, name, workspaceId, createdByUserId, mimeType: 'text/plain', sizeBytes: size,
      objectKey: workspaceArtifactKey(workspaceId, id), source: 'upload' as const, status: 'ready' as const,
      createdAt: timestamp, updatedAt: timestamp, metadata: { private: 'internal-only' },
    });
    const outside = artifact(foreign, 'outside.txt', '8', owner.user.userId);
    await app.dataSource.getRepository(WorkspaceArtifact).insert([
      artifact(own[0], 'Report_100%.txt', '2', owner.user.userId),
      artifact(own[1], 'ReportX100Y.txt', '10', owner.user.userId),
      { ...artifact(peer, 'peer.txt', '3', reader.user.userId), source: 'agent' },
      artifact(orphan, 'removed-creator.txt', '4', null),
      { ...artifact(pending, 'pending.txt', '1', owner.user.userId), status: 'pending', expiresAt: new Date() },
      { ...artifact(deleted, 'deleted.txt', '1', owner.user.userId), status: 'deleted' },
      { ...outside, workspaceId: reader.workspace.id, objectKey: workspaceArtifactKey(reader.workspace.id, foreign) },
    ]);
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('paginates ready owned files, breaks timestamp ties, and exposes only approved metadata', async () => {
    const first = await list(owner.headers).query({ limit: 1 }).expect(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.body).toEqual({ data: [{
      id: own[0], name: 'Report_100%.txt', mimeType: 'text/plain', sizeBytes: 2,
      source: 'upload', createdBy: { id: owner.user.userId, name: expect.any(String), image: null },
      isOwner: true, createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
    }], total: 2, limit: 1, page: 1, pageCount: 2, hasNextPage: true });
    const second = await list(owner.headers).query({ limit: 1, page: 2 }).expect(200);
    expect(second.body).toMatchObject({ data: [{ id: own[1] }], hasNextPage: false });
    const search = await list(owner.headers).query({ search: 'report_100%' }).expect(200);
    expect(search.body).toMatchObject({ total: 1, data: [{ id: own[0] }] });
    const sorted = await list(owner.headers).query({ sortBy: 'sizeBytes', sortOrder: 'DESC' }).expect(200);
    expect(sorted.body).toMatchObject({ data: [{ id: own[1] }, { id: own[0] }] });
  });

  it('requires workspace read and adds artifact.manage for the all scope', async () => {
    await list({}).expect(401);
    await detail(own[0], {}).expect(401);
    await list(readerHeaders()).expect(403);
    await detail(own[0], readerHeaders()).expect(403);
    const workspaceId = owner.workspace.id;
    const [{ id: member }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2) RETURNING id', [workspaceId, reader.user.userId],
    );
    [{ id: groupId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3) RETURNING id',
      ['File listing fixture', ['artifact.manage'], workspaceId],
    );
    await app.dataSource.query('INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)', [member, groupId]);
    await list(readerHeaders()).query({ scope: 'all' }).expect(403);
    await detail(peer, readerHeaders()).expect(403);
    for (const access of ['artifact.read', 'artifact.write']) {
      await permissions([access]);
      const mine = await list(readerHeaders()).expect(200);
      expect(mine.body).toMatchObject({ total: 1, data: [{ id: peer, isOwner: true }] });
      const owned = await detail(peer, readerHeaders()).expect(200);
      expect(owned.body).toEqual(mine.body.data[0]);
      const hidden = await detail(own[0], readerHeaders()).expect(404);
      const missing = await detail(unknown, readerHeaders()).expect(404);
      expect(hidden.body.message).toBe(missing.body.message);
      await list(readerHeaders()).query({ scope: 'all' }).expect(403);
    }
    await permissions(['artifact.read', 'artifact.manage']);
    for (const headers of [readerHeaders(), owner.headers]) {
      const all = await list(headers).query({ scope: 'all' }).expect(200);
      const ids = (all.body as { data: { id: string }[] }).data.map(item => item.id);
      expect(ids.sort()).toEqual([...own, peer, orphan].sort());
      expect(all.body).toMatchObject({ total: 4, data: expect.arrayContaining([
        expect.objectContaining({ id: orphan, createdBy: null, isOwner: false }),
      ]) });
      const expectedPeer = all.body.data.find((item: { id: string }) => item.id === peer);
      expect((await detail(peer, headers).expect(200)).body).toEqual(expectedPeer);
      expect((await detail(orphan, headers).expect(200)).body).toMatchObject({ createdBy: null, isOwner: false });
      await detail(foreign, headers).expect(404);
    }
  });

  it('returns only ready file metadata and keeps the usage route reachable', async () => {
    const listing = await list(owner.headers).query({ limit: 1 }).expect(200);
    const response = await detail(own[0], owner.headers).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual(listing.body.data[0]);
    for (const id of [pending, deleted, unknown]) {
      await detail(id, owner.headers).expect(404);
    }
    await detail('invalid-id', owner.headers).expect(400);
    await request(app.server).get('/api/artifacts/usage').set(owner.headers).expect(200);
  });

  it('rejects unsupported scope, sort fields, and invalid pagination', async () => {
    for (const query of [
      { scope: 'shared' }, { sortBy: 'metadata' }, { sortOrder: 'invalid' },
      { limit: 0 }, { limit: 101 }, { page: 0 }, { page: 1.5 }, { search: '\0' },
    ]) {
      await list(owner.headers).query(query).expect(400);
    }
  });
});
