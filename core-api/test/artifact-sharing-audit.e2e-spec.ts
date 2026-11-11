import { workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { AuditActorType, AuditOutcome } from '@/common/enums/enum';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { AuditEvent } from '@/modules/audit/entities/audit-event.entity';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';

describe('File sharing audit persistence (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let recipient: Awaited<ReturnType<typeof createUser>>;
  let publish: jest.SpyInstance;
  const file = randomUUID();
  const events = () => app.dataSource.getRepository(AuditEvent).find({
    where: { workspaceId: owner.workspace.id, resourceId: file },
    order: { occurredAt: 'ASC', id: 'ASC' },
  });

  async function waitForEvents(count: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await events();
      if (rows.length >= count) return rows;
      await setTimeout(100);
    }
    return events();
  }

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'file-sharing-audit');
    recipient = await createUser(app.server);
    await app.dataSource.query('INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)', [
      owner.workspace.id, recipient.userId,
    ]);
    await app.dataSource.getRepository(WorkspaceArtifact).insert({
      id: file, workspaceId: owner.workspace.id, createdByUserId: owner.user.userId,
      name: 'Private name.txt', mimeType: 'text/plain', sizeBytes: '1', source: 'upload', status: 'ready',
      objectKey: workspaceArtifactKey(owner.workspace.id, file), metadata: { content: 'private-file-content' },
    });
    publish = jest.spyOn(app.app.get(EventBridgeService), 'publish');
  });

  afterAll(async () => {
    if (!app) return;
    publish?.mockRestore();
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: owner ? [owner.workspace.id] : [],
        userIds: [owner?.user.userId, recipient?.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('persists scoped mode, add, and remove events without file or recipient data', async () => {
    await request(app.server).patch(`/api/artifacts/${file}`).set(owner.headers).send({ shareType: 'shared' }).expect(200);
    await request(app.server).post(`/api/artifacts/${file}/shares`).set(owner.headers)
      .send({ emails: [recipient.email] }).expect(201);
    await request(app.server).delete(`/api/artifacts/${file}/shares/${recipient.userId}`).set(owner.headers).expect(200);
    const rows = await waitForEvents(3);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.action).sort()).toEqual(['artifact.shared', 'artifact.unshared', 'artifact.updated']);
    for (const row of rows) {
      expect(row).toMatchObject({
        workspaceId: owner.workspace.id, actorId: owner.user.userId, actorType: AuditActorType.User,
        resourceType: 'artifact', resourceId: file, outcome: AuditOutcome.Success,
      });
    }
    expect(rows.find(row => row.action === 'artifact.updated')?.changes).toEqual({ shareType: { after: 'shared' } });
    expect(rows.find(row => row.action === 'artifact.shared')?.metadata).toEqual({ shared: 1, skipped: 0 });
    const envelopes = publish.mock.calls.filter(([name]) => String(name).startsWith('artifact.')).map(([, data]) => data as object);
    const serialized = JSON.stringify(envelopes);
    for (const value of [recipient.email, 'Private name.txt', 'objectKey', 'private-file-content', 'X-Amz-Signature']) {
      expect(serialized).not.toContain(value);
    }
    const catalog = await request(app.server).get(`/api/workspaces/${owner.workspace.id}/audit/actions`).set(owner.headers).expect(200);
    expect(catalog.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'artifact.updated' }), expect.objectContaining({ action: 'artifact.shared' }),
      expect.objectContaining({ action: 'artifact.unshared' }),
    ]));
  });

  it('records a handler failure with its outcome and leaves reads without new sharing events', async () => {
    await request(app.server).post(`/api/artifacts/${file}/shares`).set(owner.headers)
      .send({ emails: ['invalid'] }).expect(400);
    const rows = await waitForEvents(4);
    expect(rows).toHaveLength(4);
    expect(rows.filter(row => row.outcome === AuditOutcome.Failure)).toEqual([
      expect.objectContaining({ action: 'artifact.shared', workspaceId: owner.workspace.id, resourceId: file }),
    ]);
    await request(app.server).get(`/api/artifacts/${file}/shares`).set(owner.headers).expect(200);
    await request(app.server).get(`/api/artifacts/${file}`).set(owner.headers).expect(200);
    expect(await events()).toHaveLength(4);
  });
});
