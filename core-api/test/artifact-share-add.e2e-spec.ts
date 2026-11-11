import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { ArtifactShare } from '@/modules/artifacts/entities/artifact-share.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';

describe('Adding artifact share recipients (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let recipient: Awaited<ReturnType<typeof createUser>>;
  let outsider: typeof recipient;
  let groupId: string;
  const ready = randomUUID();
  const pending = randomUUID();
  const otherWorkspace = randomUUID();
  const add = (id: string, headers: Record<string, string>, body: object) =>
    request(app.server).post(`/api/artifacts/${id}/shares`).set(headers).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'share-add-owner');
    recipient = await createUser(app.server, { name: 'Current member' });
    outsider = await createUser(app.server, { name: 'Outside member' });
    const workspaceId = owner.workspace.id;
    await app.dataSource.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [otherWorkspace, otherWorkspace]);
    const file = (id: string, workspace: string) => ({
      id, workspaceId: workspace, createdByUserId: owner.user.userId, name: 'file.txt',
      mimeType: 'text/plain', sizeBytes: '1', objectKey: workspaceArtifactKey(workspace, id),
      source: 'upload' as const, status: 'ready' as const,
    });
    await app.dataSource.getRepository(WorkspaceArtifact).insert([
      file(ready, workspaceId),
      { ...file(pending, workspaceId), status: 'pending', expiresAt: new Date(Date.now() + 3600000) },
      file(otherWorkspace, otherWorkspace),
    ]);
    const [{ id: memberId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2), ($3, $4) RETURNING id',
      [workspaceId, recipient.userId, otherWorkspace, outsider.userId],
    );
    [{ id: groupId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions ("workspaceId", name, permissions) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, 'File reader', ['artifact.read']],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)',
      [memberId, groupId],
    );
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [otherWorkspace, ...(owner ? [owner.workspace.id] : [])],
        userIds: [owner?.user.userId, recipient?.userId, outsider?.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('adds one record for a current member despite duplicate inputs and concurrent retries', async () => {
    const emails = [` ${recipient.email.toUpperCase()} `, recipient.email, owner.user.email, outsider.email, 'missing@example.invalid'];
    await Promise.all([
      add(ready, owner.headers, { emails }).expect(201, { shared: 1, skipped: 3 }),
      add(ready, owner.headers, { emails }).expect(201, { shared: 1, skipped: 3 }),
    ]);
    const shares = await app.dataSource.getRepository(ArtifactShare).findBy({ artifactId: ready });
    expect(shares.map(share => share.userId)).toEqual([recipient.userId]);
    await request(app.server).get(`/api/artifacts/${ready}/shares`).set(owner.headers)
      .expect(200, [{ id: recipient.userId, name: 'Current member', image: null }]);
  });

  it('leaves recipient download access unchanged', async () => {
    await add(ready, owner.headers, { emails: [recipient.email] }).expect(201, { shared: 1, skipped: 0 });
    await request(app.server).get(`/api/artifacts/${ready}/download`)
      .set(wsHeaders(recipient.cookie, owner.workspace.id)).expect(404);
  });

  it('requires authentication, write permission, and ownership', async () => {
    const body = { emails: [recipient.email] };
    const headers = wsHeaders(recipient.cookie, owner.workspace.id);
    await add(ready, {}, body).expect(401);
    await add(ready, headers, body).expect(403);
    await app.dataSource.query('UPDATE workspace_permissions SET permissions = $1 WHERE id = $2', [
      ['artifact.read', 'artifact.write', 'artifact.manage'], groupId,
    ]);
    await add(ready, headers, body).expect(404);
  });

  it('rejects malformed email lists and invalid file IDs', async () => {
    for (const body of [{}, { emails: 'a@example.com' }, { emails: [null] }, { emails: ['bad'] }, { emails: Array(51).fill('a@example.com') }]) {
      await add(ready, owner.headers, body).expect(400);
    }
    await add('invalid', owner.headers, { emails: [recipient.email] }).expect(400);
  });

  it('returns 404 for pending, absent, and other-workspace files', async () => {
    for (const id of [pending, otherWorkspace, randomUUID()]) {
      await add(id, owner.headers, { emails: [recipient.email] }).expect(404);
    }
  });
});
