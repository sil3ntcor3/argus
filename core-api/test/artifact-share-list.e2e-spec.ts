import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { ArtifactShare } from '@/modules/artifacts/entities/artifact-share.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';

describe('Artifact share recipient listing (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let recipient: Awaited<ReturnType<typeof createUser>>;
  let formerMember: typeof recipient;
  let groupId: string;
  const ready = randomUUID();
  const empty = randomUUID();
  const pending = randomUUID();
  const outside = randomUUID();
  const list = (id: string, headers: Record<string, string>) =>
    request(app.server).get(`/api/artifacts/${id}/shares`).set(headers);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'share-owner');
    recipient = await createUser(app.server, { name: 'Share recipient' });
    formerMember = await createUser(app.server, { name: 'Former recipient' });
    const workspaceId = owner.workspace.id;
    await app.dataSource.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [outside, outside]);
    const file = (id: string, workspace: string) => ({
      id, workspaceId: workspace, createdByUserId: owner.user.userId, name: 'file.txt',
      mimeType: 'text/plain', sizeBytes: '1', objectKey: workspaceArtifactKey(workspace, id),
      source: 'upload' as const, status: 'ready' as const,
    });
    await app.dataSource.getRepository(WorkspaceArtifact).insert([
      file(ready, workspaceId),
      file(empty, workspaceId),
      { ...file(pending, workspaceId), status: 'pending', expiresAt: new Date(Date.now() + 3600000) },
      file(outside, outside),
    ]);
    const [{ id: memberId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2) RETURNING id',
      [workspaceId, recipient.userId],
    );
    [{ id: groupId }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions ("workspaceId", name, permissions) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, 'Recipient access', ['artifact.read']],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)',
      [memberId, groupId],
    );
    await app.dataSource.getRepository(ArtifactShare).insert([
      { artifactId: ready, userId: recipient.userId },
      { artifactId: ready, userId: formerMember.userId },
    ]);
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [outside, ...(owner ? [owner.workspace.id] : [])],
        userIds: [owner?.user.userId, recipient?.userId, formerMember?.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('returns only current recipients and their approved fields', async () => {
    const result = await list(ready, owner.headers).expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual([{ id: recipient.userId, name: 'Share recipient', image: null }]);
    await list(empty, owner.headers).expect(200, []);
  });

  it('requires authentication, write permission, and file ownership', async () => {
    await list(ready, {}).expect(401);
    const headers = wsHeaders(recipient.cookie, owner.workspace.id);
    await list(ready, headers).expect(403);
    await app.dataSource.query('UPDATE workspace_permissions SET permissions = $1 WHERE id = $2', [
      ['artifact.write', 'artifact.manage'], groupId,
    ]);
    await list(ready, headers).expect(404);
  });

  it('rejects invalid IDs and hides pending, absent, and out-of-workspace files', async () => {
    await list('invalid', owner.headers).expect(400);
    for (const id of [pending, outside, randomUUID()]) {
      await list(id, owner.headers).expect(404);
    }
  });
});
