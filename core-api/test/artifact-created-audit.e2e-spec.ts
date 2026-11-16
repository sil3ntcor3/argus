import { AuditActorType, AuditOutcome } from '@/common/enums/enum';
import { ArtifactBufferService } from '@/modules/artifacts/artifact-buffer.service';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { AuditEvent } from '@/modules/audit/entities/audit-event.entity';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { StorageService } from '@/modules/storage/storage.service';
import { setTimeout } from 'node:timers/promises';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Agent file creation audit (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let outsider: typeof owner;
  let writer: ArtifactBufferService;
  let storage: StorageService;
  let publish: jest.SpyInstance;
  const input = () => ({ workspaceId: owner.workspace.id, userId: owner.user.userId,
    name: 'Confidential report.txt', contentType: 'text/plain', buffer: Buffer.from('Private résumé 🔒') });
  const events = () => app.dataSource.getRepository(AuditEvent).findBy({ workspaceId: owner.workspace.id, action: 'artifact.created' });

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'created-audit-owner');
    outsider = await createUserWithWorkspace(app.server, 'created-audit-outsider');
    writer = app.app.get(ArtifactBufferService);
    storage = app.app.get(StorageService);
    publish = jest.spyOn(app.app.get(EventBridgeService), 'publish');
  });
  afterAll(async () => {
    if (!app) return;
    jest.restoreAllMocks();
    try {
      if (owner) for (const file of await app.dataSource.getRepository(WorkspaceArtifact).findBy({ workspaceId: owner.workspace.id })) {
        await storage.deleteArtifactUploadObjects({ workspaceId: owner.workspace.id, artifactId: file.id });
      }
      await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id, outsider?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, outsider?.user.userId].filter(Boolean) });
    } finally { await closeTestApp(app.app); }
  });

  it('persists the committed file event and exposes its filter only in the selected workspace', async () => {
    const data = input();
    const file = await writer.createAgentFile(data);
    let rows: AuditEvent[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      rows = await events();
      if (rows.length) break;
      await setTimeout(100);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'artifact.created', workspaceId: owner.workspace.id,
      actorId: owner.user.userId, actorType: AuditActorType.Agent, outcome: AuditOutcome.Success,
      resourceType: 'artifact', resourceId: file.id, changes: {}, metadata: { source: 'agent', sizeBytes: data.buffer.length } });
    const envelopes = publish.mock.calls.filter(([event]) => event.name === 'artifact.created');
    expect(envelopes).toHaveLength(1);
    for (const privateValue of [data.name, data.buffer.toString(), file.objectKey, 'conversation', 'X-Amz-', 'mimeType']) {
      expect(JSON.stringify(envelopes)).not.toContain(privateValue);
    }
    const catalog = await request(app.server).get(`/api/workspaces/${owner.workspace.id}/audit/actions`).set(owner.headers).expect(200);
    expect(catalog.body.data).toContainEqual({ action: 'artifact.created', label: 'Agent saved file' });
    const feed = await request(app.server).get(`/api/workspaces/${owner.workspace.id}/audit`)
      .query({ action: 'artifact.created' }).set(owner.headers).expect(200);
    expect(feed.body.data).toEqual([expect.objectContaining({ resourceId: file.id, action: 'artifact.created' })]);
    const foreign = await request(app.server).get(`/api/workspaces/${owner.workspace.id}/audit`).set(outsider.headers);
    expect([403, 404]).toContain(foreign.status);
  });

  it('publishes no creation event after quota rejection', async () => {
    await app.dataSource.transaction(manager => app.app.get(ArtifactQuotaService).setQuota(manager, owner.workspace.id, 0));
    const before = publish.mock.calls.length;
    await expect(writer.createAgentFile(input())).rejects.toMatchObject({ status: 409 });
    expect(publish.mock.calls.slice(before).filter(([event]) => event.name === 'artifact.created')).toHaveLength(0);
    expect(await events()).toHaveLength(1);
  });

  it('keeps a completed file usable when audit transport is unavailable', async () => {
    await app.dataSource.transaction(manager => app.app.get(ArtifactQuotaService).setQuota(manager, owner.workspace.id, null));
    publish.mockRejectedValueOnce(new Error('Fixture event transport outage'));
    const file = await writer.createAgentFile(input());
    expect(file.status).toBe('ready');
    const result = await request(app.server).get(`/api/artifacts/${file.id}/download`).set(owner.headers).expect(200);
    expect(await (await fetch((result.body as { url: string }).url)).text()).toBe(input().buffer.toString());
  });
});
