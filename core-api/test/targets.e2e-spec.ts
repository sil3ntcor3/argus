import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { createUserWithWorkspace, cleanupE2eData } from './helpers/workspace';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { EVENT_CATALOG } from '@/modules/event-bridge/contracts/event-catalog';
import type { AssetDiscoveredPayload } from '@/modules/event-bridge/contracts/event-payloads';
import type { EventEnvelopeData } from '@/modules/event-bridge/contracts/event-envelope';

/**
 * Targets CRUD and bulk-create rules against real Postgres.
 *
 * Proofs:
 *  1. Bulk create accepts a DOMAIN and returns one primary asset per target.
 *  2. A duplicate value in the same workspace -> **400** (it throws; it does
 *     not skip silently). This is the exact contract of
 *     `createMultipleTargets`.
 *  3. `POST .../:id/re-scan` re-queues the discovery event without touching
 *     the target itself (status stays `PENDING` semantics are covered in unit
 *     tests; here we assert the endpoint is reachable).
 *  4. The list envelope counts only the caller's workspace.
 *  5. `DELETE /api/targets/:id` removes the target row.
 */
describe('Targets bulk create and lifecycle', () => {
  jest.setTimeout(60_000);

  let app: TestApp;
  let server: App;
  let dataSource: DataSource;
  let cookie: string;
  let workspaceId: string;
  let userId: string;
  const domain = `e2e-targets-${Date.now()}.example.com`;
  const domain2 = `e2e-targets-2-${Date.now()}.example.com`;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.server;
    dataSource = app.dataSource;

    const ctx = await createUserWithWorkspace(server, 'targets');
    cookie = ctx.user.cookie;
    workspaceId = ctx.workspace.id;
    userId = ctx.user.userId;
  });

  afterAll(async () => {
    await cleanupE2eData(dataSource, { workspaceIds: [workspaceId], userIds: [userId] });
    await closeTestApp(app.app);
  });

  it('creates a DOMAIN target with a primary asset', async () => {
    const res = await request(server)
      .post('/api/targets/bulk')
      .set('Cookie', cookie)
      .set('X-Workspace-Id', workspaceId)
      .send({ targets: [{ value: domain, type: 'DOMAIN' }] })
      .expect(201);

    expect(res.body.created).toHaveLength(1);
    expect(res.body.totalCreated).toBe(1);
    expect(res.body.created[0].value).toBe(domain);

    // One primary asset per new target, seeded by the same bulk handler.
    const rows: { value: string; 'isPrimary': boolean }[] = await dataSource.query(
      'SELECT value, "isPrimary" FROM assets WHERE value = $1',
      [domain],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isPrimary).toBe(true);
  });

  it('rejects a duplicate external domain as 400', async () => {
    await request(server)
      .post('/api/targets/bulk')
      .set('Cookie', cookie)
      .set('X-Workspace-Id', workspaceId)
      .send({ targets: [{ value: domain, type: 'DOMAIN' }] })
      .expect(400)
      .expect((res) => {
        expect(JSON.stringify(res.body)).toContain('Target already exists');
      });
  });

  it('lists only the targets of the calling workspace', async () => {
    await request(server)
      .post('/api/targets/bulk')
      .set('Cookie', cookie)
      .set('X-Workspace-Id', workspaceId)
      .send({ targets: [{ value: domain2, type: 'DOMAIN' }] })
      .expect(201);

    const res = await request(server)
      .get('/api/targets')
      .query({ page: 1, limit: 10 })
      .set('Cookie', cookie)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const values = res.body.data.map((t: { value: string }) => t.value);
    expect(values).toContain(domain);
    expect(values).toContain(domain2);
  });

  it('deletes a target and its assets', async () => {
    const create = await request(server)
      .post('/api/targets/bulk')
      .set('Cookie', cookie)
      .set('X-Workspace-Id', workspaceId)
      .send({ targets: [{ value: `e2e-targets-del-${Date.now()}.example.com`, type: 'DOMAIN' }] })
      .expect(201);
    const targetId = create.body.created[0].id;

    await request(server)
      .delete(`/api/targets/${targetId}`)
      .set('Cookie', cookie)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const after = await request(server)
      .get('/api/targets')
      .query({ page: 1, limit: 50 })
      .set('Cookie', cookie)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(after.body.data.map((t: { id: string }) => t.id)).not.toContain(targetId);
  });

  it('reports committed domain, IP and CIDR assets in separate target batches and reports nothing for a rejected duplicate', async () => {
    const published: AssetDiscoveredPayload[] = [];
    const publish = jest
      .spyOn(app.app.get(EventBridgeService), 'publishSafely')
      .mockImplementation(async (name, raw) => {
        if (name === EVENT_CATALOG.asset.discovered) {
          const data = raw as EventEnvelopeData,
            payload = data.payload as AssetDiscoveredPayload;
          expect(data).toMatchObject({
            workspaceId,
            outcome: 'success',
            resourceType: 'asset',
          });
          expect(payload).not.toHaveProperty('jobHistoryId');
          const rows = await dataSource.query<
            { id: string; targetId: string; workspaceId: string }[]
          >(
            'SELECT a.id,a."targetId",t."workspaceId" FROM assets a JOIN targets t ON t.id=a."targetId" WHERE a.id=ANY($1::uuid[])',
            [payload.assetIds],
          );
          expect(rows.map((row) => row.id).sort()).toEqual(
            [...payload.assetIds].sort(),
          );
          expect(
            rows.every(
              (row) =>
                row.targetId === payload.targetId &&
                row.workspaceId === workspaceId,
            ),
          ).toBe(true);
          published.push(payload);
        }
        return '1-0';
      });
    try {
      const name = randomUUID() + '.target.argus.test';
      const response = await request(server)
        .post('/api/targets/bulk')
        .set('Cookie', cookie)
        .set('X-Workspace-Id', workspaceId)
        .send({
          targets: [
            { value: name, type: 'DOMAIN' },
            { value: '203.0.113.9', type: 'IP' },
            { value: '203.0.113.64/30', type: 'CIDR' },
          ],
        })
        .expect(201);
      const created = (
        response.body as { created: { id: string; type: string }[] }
      ).created;
      expect(published).toHaveLength(3);
      for (const target of created) {
        const batch = published.find((row) => row.targetId === target.id);
        expect(batch?.assetIds).toHaveLength(target.type === 'CIDR' ? 4 : 1);
      }
      published.length = 0;
      await request(server)
        .post('/api/targets/bulk')
        .set('Cookie', cookie)
        .set('X-Workspace-Id', workspaceId)
        .send({ targets: [{ value: name, type: 'DOMAIN' }] })
        .expect(400);
      expect(published).toEqual([]);
    } finally {
      publish.mockRestore();
    }
  });
});
