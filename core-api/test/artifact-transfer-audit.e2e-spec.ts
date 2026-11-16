import { ARTIFACT_BUCKET, workspaceArtifactKey } from '@/common/constants/artifact-storage';
import { AuditOutcome } from '@/common/enums/enum';
import { ArtifactShare } from '@/modules/artifacts/entities/artifact-share.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from '@/modules/artifacts/entities/workspace-storage-usage.entity';
import { AuditEvent } from '@/modules/audit/entities/audit-event.entity';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('File download and deletion audit persistence (e2e)', () => {
  let app: TestApp;
  let storage: StorageService;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let recipient: typeof owner;
  let publish: jest.SpyInstance;
  let signedUrl: string;
  const file = randomUUID();
  const content = 'private-file-content';
  const recipientHeaders = () => wsHeaders(recipient.user.cookie, owner.workspace.id);

  async function waitForEvents(count: number) {
    let rows: AuditEvent[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      rows = await app.dataSource.getRepository(AuditEvent).find({
        where: { workspaceId: owner.workspace.id, resourceId: file },
      });
      if (rows.length >= count) return rows;
      await setTimeout(100);
    }
    return rows;
  }

  beforeAll(async () => {
    app = await createTestApp();
    storage = app.app.get(StorageService);
    owner = await createUserWithWorkspace(app.server, 'file-transfer-owner');
    recipient = await createUserWithWorkspace(app.server, 'file-transfer-recipient');
    const [{ id: member }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2) RETURNING id',
      [owner.workspace.id, recipient.user.userId],
    );
    const [{ id: group }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions ("workspaceId",name,permissions) VALUES ($1,$2,$3) RETURNING id',
      [owner.workspace.id, 'Transfer audit fixture', ['artifact.read', 'artifact.manage']],
    );
    await app.dataSource.query('INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)', [member, group]);
    await app.dataSource.getRepository(WorkspaceArtifact).insert({
      id: file, workspaceId: owner.workspace.id, createdByUserId: owner.user.userId,
      name: 'Private transfer.txt', mimeType: 'text/plain', sizeBytes: String(Buffer.byteLength(content)),
      source: 'upload', status: 'ready', shareType: 'shared', objectKey: workspaceArtifactKey(owner.workspace.id, file),
    });
    await app.dataSource.getRepository(WorkspaceStorageUsage).insert({
      workspaceId: owner.workspace.id, usedBytes: String(Buffer.byteLength(content)), reservedBytes: '0',
    });
    await app.dataSource.getRepository(ArtifactShare).insert({ artifactId: file, userId: recipient.user.userId });
    await storage.uploadFile(workspaceArtifactKey(owner.workspace.id, file), Buffer.from(content), ARTIFACT_BUCKET, 'text/plain');
    publish = jest.spyOn(app.app.get(EventBridgeService), 'publish');
  });

  afterAll(async () => {
    if (!app) return;
    publish?.mockRestore();
    try {
      if (owner && storage) await storage.deleteArtifactUploadObjects({ workspaceId: owner.workspace.id, artifactId: file });
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, recipient?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, recipient?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('records owner and named-recipient URL issuance without signed URLs or file data', async () => {
    const download = await request(app.server).get(`/api/artifacts/${file}/download`).set(owner.headers).expect(200);
    signedUrl = (download.body as { url: string; expiresIn: number }).url;
    expect(download.body).toMatchObject({ expiresIn: 300 });
    const attachment = await fetch(signedUrl);
    expect(attachment.status).toBe(200);
    expect(await attachment.text()).toBe(content);
    await request(app.server).get(`/api/artifacts/${file}/download`).set(recipientHeaders()).expect(200);
    const rows = await waitForEvents(2);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.actorId).sort()).toEqual([owner.user.userId, recipient.user.userId].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        action: 'artifact.downloaded', workspaceId: owner.workspace.id, resourceType: 'artifact',
        resourceId: file, outcome: AuditOutcome.Success,
      });
      expect(row.changes).toEqual({});
      expect(row.metadata).toEqual({});
    }
    const envelopes = JSON.stringify(publish.mock.calls.filter(([name]) => name === 'artifact.downloaded'));
    for (const excluded of [signedUrl, 'X-Amz-Signature', 'Private transfer.txt', content, 'objectKey']) {
      expect(envelopes).not.toContain(excluded);
    }
  });

  it('records logical deletion and failed retries after storage and quota cleanup', async () => {
    await request(app.server).delete(`/api/artifacts/${file}`).set(recipientHeaders()).expect(200);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).findOneBy({ id: file })).toBeNull();
    expect(await app.dataSource.getRepository(WorkspaceStorageUsage).findOneBy({ workspaceId: owner.workspace.id }))
      .toMatchObject({ usedBytes: '0', reservedBytes: '0' });
    const removed = await fetch(signedUrl);
    expect(removed.status).toBe(404);
    await removed.body?.cancel();
    await request(app.server).get(`/api/artifacts/${file}/download`).set(owner.headers).expect(404);
    await request(app.server).delete(`/api/artifacts/${file}`).set(recipientHeaders()).expect(404);
    const rows = await waitForEvents(5);
    expect(rows).toHaveLength(5);
    expect(rows.filter(row => row.action === 'artifact.deleted' && row.outcome === AuditOutcome.Success)).toEqual([
      expect.objectContaining({ actorId: recipient.user.userId, resourceId: file }),
    ]);
    expect(rows.filter(row => row.outcome === AuditOutcome.Failure).map(row => row.action).sort())
      .toEqual(['artifact.deleted', 'artifact.downloaded']);
    const catalog = await request(app.server).get(`/api/workspaces/${owner.workspace.id}/audit/actions`).set(owner.headers).expect(200);
    expect(catalog.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'artifact.downloaded', label: 'Requested file download' }),
      expect.objectContaining({ action: 'artifact.deleted' }),
    ]));
  });
});
